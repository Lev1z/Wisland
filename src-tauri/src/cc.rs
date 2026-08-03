use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::logger;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

const TAG: &str = "CC";
const DEFAULT_PORT: u16 = 2221;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcRoute {
    pub path: String,
    pub tag: String,
    pub time: u64,
}

/// 启动 Claude Code 通知服务器（阻塞，需在独立线程中调用）
pub fn start_server(
    window: tauri::WebviewWindow,
    is_notifying: Arc<AtomicBool>,
    is_expanded: Arc<AtomicBool>,
    routes: Arc<Mutex<Vec<CcRoute>>>,
) {
    let addr = format!("127.0.0.1:{}", DEFAULT_PORT);

    let listener = match TcpListener::bind(&addr) {
        Ok(l) => {
            logger::info(TAG, &format!("server listening on {}", addr));
            l
        }
        Err(e) => {
            logger::info(TAG, &format!("failed to bind {}: {}", addr, e));
            return;
        }
    };

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => {
                let peer = s
                    .peer_addr()
                    .map(|a| a.to_string())
                    .unwrap_or("unknown".into());
                logger::info(TAG, &format!("incoming connection from {}", peer));
                s
            }
            Err(e) => {
                logger::debug(TAG, &format!("accept error: {e}"));
                continue;
            }
        };

        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            continue;
        }

        // 解析 "GET /path HTTP/1.x"
        let request_target = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        let (path, query_values) = split_request_target(&request_target);

        // 消耗剩余 header（读到空行为止）
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                _ => {
                    if line.trim().is_empty() {
                        break;
                    }
                }
            }
        }

        // 从配置中动态匹配路径
        let matched = routes
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.path == path)
            .cloned();

        let (status, body, notice_tag) = if let Some(route) = &matched {
            let tag = render_tag(&route.tag, &query_values);
            logger::info(TAG, &format!("received: {} -> {}", request_target, tag));
            (
                "200 OK",
                serde_json::json!({"ok": true, "message": tag}).to_string(),
                Some(tag),
            )
        } else {
            logger::info(TAG, &format!("unknown path: {}", request_target));
            (
                "404 Not Found",
                serde_json::json!({"ok": false, "error": "unknown path"}).to_string(),
                None,
            )
        };

        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status,
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());

        if let (Some(route), Some(tag)) = (matched, notice_tag) {
            // 通知前端
            is_notifying.store(true, Ordering::Relaxed);
            is_expanded.store(true, Ordering::Relaxed);
            let _ = window.emit("set-expand", true);
            let _ = window.emit("show-notice", &tag);

            // 超时自动收起
            let noti = is_notifying.clone();
            let exp = is_expanded.clone();
            let win = window.clone();
            let timeout = route.time;
            thread::spawn(move || {
                thread::sleep(std::time::Duration::from_millis(timeout));
                noti.store(false, Ordering::Relaxed);
                exp.store(false, Ordering::Relaxed);
                let _ = win.emit("set-expand", false);
                let _ = win.emit("notice-timeout", ());
            });
        }
    }
}

fn split_request_target(target: &str) -> (String, Vec<String>) {
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (target.to_string(), ""),
    };
    let values = query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let value = part.split_once('=').map(|(_, value)| value).unwrap_or(part);
            percent_decode(value)
        })
        .collect();
    (path, values)
}

fn render_tag(template: &str, values: &[String]) -> String {
    let mut tag = template.to_string();
    for (idx, value) in values.iter().enumerate() {
        tag = tag.replace(&format!("${}", idx + 1), value);
    }
    tag
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    out.push(value);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}
