//! Logical headings over a bounded, immutable transcript. A heading anchor is
//! a reading position, never a reconstructed request start or duration.
use super::{ModelCall, RuntimeEvent};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

type Key = (String, String); // turn + response, scoped to this selected history

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelPresentation {
    pub association: String,
    pub purpose: String,
    pub anchor_id: String,
}

#[derive(Default)]
pub(super) struct ModelView {
    identities: HashMap<Key, (String, u32)>,
    next_number: u32,
}

struct Group {
    key: Key,
    record: usize,
    compaction: bool,
    members: HashMap<usize, &'static str>,
}

fn payload(event: &RuntimeEvent) -> &Value {
    let p = &event.detail["raw"]["payload"];
    if p["type"] == "item_completed" {
        &p["item"]
    } else {
        p
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty())
}

fn response(event: &RuntimeEvent) -> Option<&str> {
    nonempty(&payload(event)["response_id"])
        .or_else(|| nonempty(&event.detail["raw"]["metadata"]["response_id"]))
        .or_else(|| nonempty(&event.detail["raw"]["payload"]["response_id"]))
}

fn compaction_response(event: &RuntimeEvent) -> Option<&str> {
    // Do not use latest_token_usage_record: it is a resume checkpoint, not
    // evidence that the most recent normal response generated this compaction.
    (event.kind == "compaction")
        .then(|| nonempty(&payload(event)["compaction_response_id"]))
        .flatten()
}

fn compaction_output(event: &RuntimeEvent) -> bool {
    event.detail["raw"]["metadata"]["compaction_output"] == true
        || event.detail["mirror"]["metadata"]["compaction_output"] == true
}

fn model_output(event: &RuntimeEvent) -> bool {
    let metadata = &event.detail["raw"]["metadata"];
    if metadata["inherited_user_message"] == true
        || !metadata["delivered_assistant_message"].is_null()
        || !metadata["retained_source"].is_null()
    {
        return false;
    }
    // Runtime CommandExecution/McpToolCall items can be nested work from exec.
    // They are not evidence of a new model response.
    matches!(event.kind.as_str(), "assistant" | "summary")
        || (event.kind == "tool" && event.source_type.starts_with("response_item."))
}

fn lookup(groups: &[Group], turn: &str, response: &str) -> Option<usize> {
    if let Some(index) = groups
        .iter()
        .position(|g| g.key.0 == turn && g.key.1 == response)
    {
        return Some(index);
    }
    // Explicit identity may connect a background request with a later install.
    // Ambiguous inherited/replayed IDs must not be resolved by proximity.
    let mut matches = groups
        .iter()
        .enumerate()
        .filter(|(_, g)| g.key.1 == response);
    let (index, _) = matches.next()?;
    matches.next().is_none().then_some(index)
}

fn remaining(
    pending: &mut Vec<usize>,
    owners: &HashMap<usize, usize>,
    unresolved: &mut Vec<Vec<usize>>,
) {
    let rows: Vec<_> = pending
        .drain(..)
        .filter(|i| !owners.contains_key(i))
        .collect();
    if !rows.is_empty() {
        unresolved.push(rows);
    }
}

impl ModelView {
    pub(super) fn build(&mut self, source: &VecDeque<RuntimeEvent>) -> Vec<RuntimeEvent> {
        let mut events: Vec<_> = source.iter().cloned().collect();
        let mut groups: Vec<Group> = events
            .iter()
            .enumerate()
            .filter_map(|(i, event)| {
                event.model_call.as_ref().map(|call| Group {
                    key: (event.turn_id.clone(), call.response_id.clone()),
                    record: i,
                    compaction: false,
                    members: HashMap::new(),
                })
            })
            .collect();

        // Resolve explicit compaction identity before considering normal output
        // spans, including when the installation arrived in a later poll.
        for (i, event) in events.iter().enumerate() {
            if let Some(response) = compaction_response(event) {
                let index = lookup(&groups, &event.turn_id, response).unwrap_or_else(|| {
                    groups.push(Group {
                        key: (event.turn_id.clone(), response.into()),
                        record: i,
                        compaction: true,
                        members: HashMap::new(),
                    });
                    groups.len() - 1
                });
                groups[index].compaction = true;
                groups[index].members.insert(i, "direct");
            }
        }
        let mut owners = HashMap::new();
        for (i, event) in events.iter().enumerate().filter(|(_, e)| model_output(e)) {
            if let Some(index) = response(event).and_then(|id| lookup(&groups, &event.turn_id, id))
            {
                // A confirmed compaction cannot own ordinary user-facing output.
                if !groups[index].compaction || compaction_output(event) {
                    groups[index].members.insert(i, "direct");
                    owners.insert(i, index);
                }
            }
        }
        let markers: HashMap<_, _> = groups
            .iter()
            .enumerate()
            .filter(|(_, g)| events[g.record].kind == "model")
            .map(|(index, g)| (g.record, index))
            .collect();
        let mut unresolved = Vec::new();
        let mut pending = Vec::new();
        let mut scope = None;
        let mut ready = false;
        for (i, event) in events.iter().enumerate() {
            // Late results retain their old turn, but are not a new input or a
            // request boundary for the foreground stream.
            if event.kind == "result" {
                continue;
            }
            let next_scope = (
                event.turn_id.as_str(),
                event.detail["rolloutId"].as_str(),
                event.continuity,
            );
            if scope != Some(next_scope) {
                remaining(&mut pending, &owners, &mut unresolved);
                ready = false;
                scope = Some(next_scope);
            }
            if event.input_boundary {
                ready = true;
            }
            if let Some(&index) = markers.get(&i) {
                let compatible = pending.iter().all(|p| {
                    let output = &events[*p];
                    owners.get(p).is_none_or(|owner| *owner == index)
                        && response(output).is_none_or(|id| id == groups[index].key.1)
                        && compaction_output(output) == groups[index].compaction
                });
                if ready && compatible && event.turn_id != "unattributed" {
                    for &p in &pending {
                        if let std::collections::hash_map::Entry::Vacant(entry) = owners.entry(p) {
                            entry.insert(index);
                            groups[index].members.insert(p, "sequence");
                        }
                    }
                }
                remaining(&mut pending, &owners, &mut unresolved);
                ready = !groups[index].compaction;
            } else if model_output(event) {
                pending.push(i);
            } else if matches!(
                event.kind.as_str(),
                "user"
                    | "system"
                    | "context"
                    | "record"
                    | "error"
                    | "lifecycle"
                    | "compaction"
                    | "assistant"
                    | "summary"
            ) {
                remaining(&mut pending, &owners, &mut unresolved);
                ready = match event.kind.as_str() {
                    "user" => true,
                    "lifecycle" => matches!(
                        payload(event)["type"].as_str(),
                        Some("task_started" | "turn_started")
                    ),
                    "context" | "system" => ready,
                    "compaction" => {
                        event.source_type.starts_with("compacted.")
                            || event.source_type.ends_with(".ContextCompaction")
                            || event.source_type.ends_with(".context_compacted")
                    }
                    _ => false,
                };
            }
        }
        remaining(&mut pending, &owners, &mut unresolved);

        let mut headings: HashMap<usize, Vec<RuntimeEvent>> = HashMap::new();
        let mut used_ids = HashSet::new();
        let mut active_keys = HashSet::new();
        // First-observed response order defines stable local numbers; they are
        // not network-attempt counts, and are not renumbered by later anchoring.
        let mut order: Vec<_> = (0..groups.len()).collect();
        order.sort_by_key(|i| groups[*i].record);
        for index in order {
            let group = &groups[index];
            let anchor = group
                .members
                .keys()
                .copied()
                .chain([group.record])
                .min()
                .unwrap();
            let output_anchor = group
                .members
                .keys()
                .copied()
                .filter(|i| model_output(&events[*i]))
                .min();
            let (id, number) = self
                .identities
                .entry(group.key.clone())
                .or_insert_with(|| {
                    self.next_number += 1;
                    (
                        output_anchor
                            .map(|i| format!("model:output:{}", events[i].id))
                            .unwrap_or_else(|| format!("model:record:{}", events[group.record].id)),
                        self.next_number,
                    )
                })
                .clone();
            active_keys.insert(group.key.clone());
            used_ids.insert(id.clone());
            let direct = group.members.values().any(|m| *m == "direct");
            let sequence = group.members.values().any(|m| *m == "sequence");
            let association = match (direct, sequence) {
                (true, true) => "mixed",
                (true, false) => "direct",
                (false, true) => "sequence",
                _ => "unassociated",
            };
            let tools = group.members.keys().any(|i| events[*i].kind == "tool");
            let content = group
                .members
                .keys()
                .any(|i| matches!(events[*i].kind.as_str(), "assistant" | "summary"));
            let purpose = if group.compaction {
                "上下文压缩"
            } else {
                match (tools, content) {
                    (true, true) => "内容生成 · 工具调用",
                    (true, false) => "工具调用",
                    (false, true) => "内容生成",
                    _ => "用途未关联",
                }
            };
            let mut header = events[group.record].clone();
            header.id = id.clone();
            header.kind = "model".into();
            header.call_id = None;
            header.timestamp = None; // The source timestamp is not a start time.
            header.model_call = Some(ModelCall {
                response_id: group.key.1.clone(),
                number,
            });
            if events[group.record].kind != "model" {
                header.status = Some("response_observed".into());
            }
            let status = match header.status.as_deref() {
                Some("response_completed") => "响应已结束",
                Some("usage_recorded") => "已记录用量",
                _ => "已关联响应",
            };
            header.summary = format!("#{number} · {purpose} · {status}");
            header.model_presentation = Some(ModelPresentation {
                association: association.into(),
                purpose: purpose.into(),
                anchor_id: events[anchor].id.clone(),
            });
            let mut member_ids: Vec<_> = group.members.keys().copied().collect();
            member_ids.sort_unstable();
            header.detail["modelAssociation"] = json!({ "method": association, "purpose": purpose,
                "anchorEventId": events[anchor].id, "sourceEventId": events[group.record].id,
                "relatedEventIds": member_ids.iter().map(|i| &events[*i].id).collect::<Vec<_>>(),
                "responseId": group.key.1, "number": number });
            for (&member, method) in &group.members {
                events[member].detail["modelAssociation"] = json!({ "headerId": id,
                    "responseId": group.key.1, "number": number, "method": method });
            }
            headings.entry(anchor).or_default().push(header);
        }
        self.identities.retain(|key, _| active_keys.contains(key));
        for rows in unresolved {
            let first = rows[0];
            let mut header = events[first].clone();
            let proposed = format!("model:output:{}", header.id);
            header.id = if used_ids.contains(&proposed) {
                format!("model:unlinked:{}", header.id)
            } else {
                proposed
            };
            header.kind = "model".into();
            header.model_call = None;
            header.call_id = None;
            header.status = Some("awaiting_association".into());
            header.timestamp = None;
            header.summary = "输出待关联 · 尚未确定模型请求".into();
            header.source_type = "wisland.model_header".into();
            header.model_presentation = Some(ModelPresentation {
                association: "pending".into(),
                purpose: "输出待关联".into(),
                anchor_id: events[first].id.clone(),
            });
            header.detail = json!({ "raw": { "type": "wisland_model_header", "payload": {
                "note": "派生阅读标题，不是 Codex 请求开始事件",
                "source_event_ids": rows.iter().map(|i| &events[*i].id).collect::<Vec<_>>() } },
                "content": header.summary, "byteOffset": events[first].detail["byteOffset"],
                "rolloutId": events[first].detail["rolloutId"], "modelAssociation": { "method": "pending" } });
            headings.entry(first).or_default().push(header);
        }
        // Associate delayed results without moving them or counting nested tools
        // as requests. Ambiguous/reused call IDs are left untouched.
        let mut calls: HashMap<(String, String), Vec<Value>> = HashMap::new();
        for event in &events {
            if event.kind == "tool" && !event.detail["modelAssociation"].is_null() {
                if let Some(call) = &event.call_id {
                    calls
                        .entry((event.turn_id.clone(), call.clone()))
                        .or_default()
                        .push(event.detail["modelAssociation"].clone());
                }
            }
        }
        for event in &mut events {
            if event.kind == "result" {
                if let Some(links) = event
                    .call_id
                    .as_ref()
                    .and_then(|c| calls.get(&(event.turn_id.clone(), c.clone())))
                {
                    if links.len() == 1 {
                        event.detail["modelAssociation"] = links[0].clone();
                        event.detail["modelAssociation"]["via"] = json!("call_id");
                    }
                }
            }
        }
        let mut view = Vec::new();
        for (i, event) in events.into_iter().enumerate() {
            if let Some(headers) = headings.remove(&i) {
                view.extend(headers);
            }
            if event.kind != "model" {
                view.push(event);
            }
        }
        view
    }
}

#[cfg(test)]
mod tests {
    use super::super::Projection;
    use super::*;

    fn line(p: &mut Projection, outer: &str, payload: Value) {
        let offset = p.events.len() as u64 * 100 + p.next_model_call as u64;
        p.ingest(
            serde_json::to_string(&json!({ "type": outer, "payload": payload }))
                .unwrap()
                .as_bytes(),
            offset,
        );
    }
    fn start(p: &mut Projection, turn: &str) {
        line(
            p,
            "event_msg",
            json!({"type":"task_started", "turn_id":turn}),
        );
    }
    fn output(p: &mut Projection, text: &str) {
        line(
            p,
            "response_item",
            json!({"type":"message", "role":"assistant", "content":text}),
        );
    }
    fn tool(p: &mut Projection, call: &str) {
        line(
            p,
            "response_item",
            json!({"type":"custom_tool_call", "name":"exec", "call_id":call, "input":"text(await tools.exec_command({cmd:'test'}))"}),
        );
    }
    fn usage(p: &mut Projection, id: &str) {
        line(
            p,
            "token_usage_record",
            json!({"response_id":id, "usage":{"total_tokens":10}}),
        );
    }
    fn view(p: &mut Projection) -> Vec<RuntimeEvent> {
        p.model_view.build(&p.events)
    }
    fn numbered(events: &[RuntimeEvent]) -> Vec<&RuntimeEvent> {
        events.iter().filter(|e| e.model_call.is_some()).collect()
    }

    #[test]
    fn promotes_pending_heading_in_place_without_reordering_raw_events() {
        let mut p = Projection::default();
        start(&mut p, "t1");
        output(&mut p, "checking");
        tool(&mut p, "c1");
        let initial = view(&mut p);
        assert_eq!(initial[1].status.as_deref(), Some("awaiting_association"));
        let pending_id = initial[1].id.clone();
        assert!(numbered(&initial).is_empty());
        usage(&mut p, "r1");
        let raw: Vec<_> = p.events.iter().map(|e| e.id.clone()).collect();
        let projected = view(&mut p);
        assert_eq!(projected[1].id, pending_id);
        assert_eq!(
            projected[1]
                .model_presentation
                .as_ref()
                .unwrap()
                .association,
            "sequence"
        );
        assert_eq!(
            projected[1].model_presentation.as_ref().unwrap().purpose,
            "内容生成 · 工具调用"
        );
        assert_eq!(projected[1].status.as_deref(), Some("usage_recorded"));
        assert!(projected[1].timestamp.is_none());
        assert_eq!(
            projected
                .iter()
                .filter(|e| e.kind != "model")
                .map(|e| &e.id)
                .collect::<Vec<_>>(),
            raw[..3].iter().collect::<Vec<_>>()
        );
        assert_eq!(
            p.events.iter().map(|e| &e.id).collect::<Vec<_>>(),
            raw.iter().collect::<Vec<_>>()
        );
        assert_eq!(projected[1].detail["raw"]["payload"]["response_id"], "r1");
    }

    #[test]
    fn usage_does_not_prove_completion_and_mirrors_never_downgrade_it() {
        let mut p = Projection::default();
        start(&mut p, "t");
        output(&mut p, "a");
        usage(&mut p, "r");
        let before = view(&mut p);
        assert_eq!(
            numbered(&before)[0].status.as_deref(),
            Some("usage_recorded")
        );
        line(
            &mut p,
            "event_msg",
            json!({"type":"raw_response_completed", "response_id":"r"}),
        );
        usage(&mut p, "r");
        let after = view(&mut p);
        let headers = numbered(&after);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].id, numbered(&before)[0].id);
        assert_eq!(headers[0].status.as_deref(), Some("response_completed"));
        assert_eq!(
            headers[0].detail["mirror"]["payload"]["type"],
            "raw_response_completed"
        );
        assert!(!headers[0].summary.contains("已完成"));
    }

    #[test]
    fn direct_response_identity_wins_over_neighboring_marker() {
        let mut p = Projection::default();
        start(&mut p, "t");
        line(
            &mut p,
            "response_item",
            json!({"type":"message", "role":"assistant", "content":"belongs to r2", "response_id":"r2"}),
        );
        usage(&mut p, "r1");
        usage(&mut p, "r2");
        let events = view(&mut p);
        let headers = numbered(&events);
        assert_eq!(headers[0].model_call.as_ref().unwrap().response_id, "r2");
        assert_eq!(
            headers[0].model_presentation.as_ref().unwrap().association,
            "direct"
        );
        assert_eq!(
            headers[1].model_presentation.as_ref().unwrap().association,
            "unassociated"
        );
    }

    #[test]
    fn missing_start_gap_file_change_and_retry_barrier_prevent_sequence_claims() {
        for barrier in ["partial", "malformed", "file", "retry", "unknown", "turn"] {
            let mut p = Projection::default();
            if barrier != "partial" {
                start(&mut p, "t1");
            }
            output(&mut p, "before boundary");
            match barrier {
                "malformed" => p.ingest(b"{broken", 42),
                "file" => p.source = "another-rollout".into(),
                "retry" => line(
                    &mut p,
                    "event_msg",
                    json!({"type":"error", "message":"retry"}),
                ),
                "unknown" => line(&mut p, "future_event", json!({"type":"unknown"})),
                "turn" => start(&mut p, "t2"),
                _ => {}
            }
            usage(&mut p, "r");
            let events = view(&mut p);
            assert_eq!(
                numbered(&events)[0]
                    .model_presentation
                    .as_ref()
                    .unwrap()
                    .association,
                "unassociated",
                "{barrier}"
            );
            assert!(events
                .iter()
                .find(|e| e.kind == "assistant")
                .unwrap()
                .detail["modelAssociation"]
                .is_null());
        }
    }

    #[test]
    fn turn_context_is_a_preparation_boundary_not_a_request_start_time() {
        let mut p = Projection::default();
        output(&mut p, "older output");
        line(&mut p, "turn_context", json!({"turn_id":"t"}));
        output(&mut p, "new output");
        usage(&mut p, "r");
        let events = view(&mut p);
        let header = numbered(&events)[0];
        assert_eq!(
            header.model_presentation.as_ref().unwrap().association,
            "sequence"
        );
        assert!(events
            .iter()
            .find(|e| e.summary == "older output")
            .unwrap()
            .detail["modelAssociation"]
            .is_null());
        assert!(!events
            .iter()
            .find(|e| e.summary == "new output")
            .unwrap()
            .detail["modelAssociation"]
            .is_null());
        assert!(header.detail["startedAt"].is_null());
    }

    #[test]
    fn late_compaction_reclassifies_response_without_claiming_ordinary_output() {
        let mut p = Projection::default();
        start(&mut p, "t");
        output(&mut p, "ordinary output");
        usage(&mut p, "compact-r");
        let before = view(&mut p);
        let id = numbered(&before)[0].id.clone();
        line(
            &mut p,
            "compacted",
            json!({"compaction_response_id":"compact-r", "message":"summary"}),
        );
        let after = view(&mut p);
        let header = numbered(&after)[0];
        assert_eq!(header.id, id);
        assert_eq!(
            header.model_presentation.as_ref().unwrap().purpose,
            "上下文压缩"
        );
        let message = after.iter().find(|e| e.kind == "assistant").unwrap();
        assert!(message.detail["modelAssociation"].is_null());
        assert_eq!(
            after.iter().map(|e| &e.id).collect::<HashSet<_>>().len(),
            after.len(),
            "reclassification cannot duplicate row IDs"
        );
    }

    #[test]
    fn explicit_compaction_output_can_anchor_the_matching_compression_response() {
        let mut p = Projection::default();
        start(&mut p, "t");
        p.ingest(
            serde_json::to_string(
                &json!({"type":"response_item", "metadata":{"compaction_output":true},
            "payload":{"type":"message", "role":"assistant", "content":"summary output"}}),
            )
            .unwrap()
            .as_bytes(),
            150,
        );
        usage(&mut p, "cr");
        line(&mut p, "compacted", json!({"compaction_response_id":"cr"}));
        let events = view(&mut p);
        assert_eq!(events[1].kind, "model");
        assert_eq!(events[2].kind, "assistant");
        assert_eq!(
            events[1].model_presentation.as_ref().unwrap().association,
            "mixed"
        );
    }

    #[test]
    fn background_install_without_usage_is_observed_not_completed_and_checkpoint_is_not_a_call() {
        let mut p = Projection::default();
        start(&mut p, "t");
        line(
            &mut p,
            "compacted",
            json!({"compaction_response_id":"background-r", "latest_token_usage_record":{"response_id":"old-normal"}}),
        );
        line(
            &mut p,
            "event_msg",
            json!({"type":"item_completed", "item":{"type":"ContextCompaction", "id":"operation"}, "started_at_ms":1, "completed_at_ms":800}),
        );
        let events = view(&mut p);
        let headers = numbered(&events);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].status.as_deref(), Some("response_observed"));
        assert!(headers[0].detail["duration_ms"].is_null());
        let mut reset = Projection::default();
        start(&mut reset, "t");
        line(
            &mut reset,
            "compacted",
            json!({"latest_token_usage_record":{"response_id":"old-normal"}}),
        );
        assert!(numbered(&view(&mut reset)).is_empty());
    }

    #[test]
    fn parallel_tools_nested_runtime_and_late_results_do_not_create_requests() {
        let mut p = Projection::default();
        start(&mut p, "t1");
        tool(&mut p, "a");
        tool(&mut p, "b");
        line(
            &mut p,
            "event_msg",
            json!({"type":"item_completed", "item":{"type":"CommandExecution", "command":"nested", "id":"nested1"}}),
        );
        usage(&mut p, "r1");
        start(&mut p, "t2");
        output(&mut p, "new response");
        line(
            &mut p,
            "response_item",
            json!({"type":"custom_tool_call_output", "call_id":"a", "turn_id":"t1", "output":"late"}),
        );
        output(&mut p, "still t2");
        usage(&mut p, "r2");
        let events = view(&mut p);
        assert_eq!(numbered(&events).len(), 2);
        let late = events.iter().find(|e| e.kind == "result").unwrap();
        assert_eq!(late.turn_id, "t1");
        assert_eq!(late.detail["modelAssociation"]["responseId"], "r1");
        assert_eq!(
            events
                .iter()
                .find(|e| e.summary == "still t2")
                .unwrap()
                .turn_id,
            "t2"
        );
        let nested = events
            .iter()
            .find(|e| e.source_type.ends_with(".CommandExecution"))
            .unwrap();
        assert!(nested.detail["modelAssociation"].is_null());
        let raw_ids: Vec<_> = p
            .events
            .iter()
            .filter(|e| e.kind != "model")
            .map(|e| &e.id)
            .collect();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.kind != "model")
                .map(|e| &e.id)
                .collect::<Vec<_>>(),
            raw_ids
        );
    }

    #[test]
    fn reused_tool_id_is_not_assigned_to_a_response_arbitrarily() {
        let mut p = Projection::default();
        start(&mut p, "t");
        tool(&mut p, "same");
        usage(&mut p, "r1");
        tool(&mut p, "same");
        usage(&mut p, "r2");
        line(
            &mut p,
            "response_item",
            json!({"type":"custom_tool_call_output", "call_id":"same", "output":"ambiguous"}),
        );
        assert!(view(&mut p)
            .iter()
            .find(|e| e.kind == "result")
            .unwrap()
            .detail["modelAssociation"]
            .is_null());
    }

    #[test]
    fn inherited_messages_and_token_totals_are_not_model_requests() {
        let mut p = Projection::default();
        start(&mut p, "t");
        p.ingest(
            serde_json::to_string(
                &json!({"type":"response_item", "metadata":{"inherited_user_message":true},
            "payload":{"type":"message", "role":"assistant", "content":"copied history"}}),
            )
            .unwrap()
            .as_bytes(),
            150,
        );
        line(
            &mut p,
            "event_msg",
            json!({"type":"token_count", "info":{"total_tokens":900}}),
        );
        assert_eq!(view(&mut p).len(), 2);
    }

    #[test]
    fn header_identity_and_number_survive_eviction_of_the_first_output() {
        let mut p = Projection::default();
        start(&mut p, "t");
        output(&mut p, "one");
        output(&mut p, "two");
        usage(&mut p, "r");
        let before = view(&mut p);
        let header = numbered(&before)[0];
        p.events.pop_front();
        p.events.pop_front();
        let after = view(&mut p);
        let next = numbered(&after)[0];
        assert_eq!(header.id, next.id);
        assert_eq!(
            header.model_call.as_ref().unwrap().number,
            next.model_call.as_ref().unwrap().number
        );
        assert_eq!(
            next.model_presentation.as_ref().unwrap().association,
            "unassociated"
        );
        assert!(p.model_view.identities.len() <= p.events.len());
    }
}
