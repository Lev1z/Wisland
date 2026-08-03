use lyrix::models::LyricsData;
use lyrix::smtc_lyrics;
#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct LyricToken {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct LyricLine {
    pub time_ms: i64,
    pub end_time_ms: i64,
    pub text: String,
    pub tokens: Vec<LyricToken>,
}

/// 通过 lyricify-lyrics-provider 统一接口获取歌词（自动检测播放器，多源 fallback）
fn fetch_lyrics_by_rust_api(
    title: &str,
    artist: &str,
    album_title: &str,
    album_artist: &str,
    app_id: &str,
    duration_ms: i64,
    gen_ref: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    gen: u64,
) -> Option<LyricsData> {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            crate::logger::warn(
                "Lyrics",
                &format!("\nrust-api: tokio runtime init failed: {}", e),
            );
            return None;
        }
    };

    let artist_opt = if artist.trim().is_empty() {
        None
    } else {
        Some(artist)
    };
    let album_opt: Option<&str> = if album_title.trim().is_empty() {
        None
    } else {
        Some(album_title)
    };
    let album_artist_opt: Option<&str> = if album_artist.trim().is_empty() {
        None
    } else {
        Some(album_artist)
    };
    let duration_ms_u32: u32 = duration_ms.clamp(0, i64::from(u32::MAX)) as u32;
    rt.block_on(async {
        crate::logger::info(
            "Lyrics",
            &format!(
                "\nrust-api: title='{}' artist='{}' album artist='{}' duration_ms={}",
                title, artist, album_artist, duration_ms
            ),
        );

        let normalized_app_id = app_id.trim().to_lowercase();
        let preferred_player = if normalized_app_id.contains("cloudmusic") {
            smtc_lyrics::MusicPlayer::Netease
        } else if normalized_app_id.contains("qqmusic") {
            smtc_lyrics::MusicPlayer::QQMusic
        } else if normalized_app_id.contains("kugou") {
            smtc_lyrics::MusicPlayer::Kugou
        } else if normalized_app_id.contains("soda")
            || normalized_app_id.contains("\u{6c7d}\u{6c34}\u{97f3}\u{4e50}")
        {
            smtc_lyrics::MusicPlayer::SodaMusic
        } else {
            smtc_lyrics::MusicPlayer::Netease
        };

        let mut players = vec![preferred_player];
        players.extend(
            smtc_lyrics::MusicPlayer::all_sorted()
                .iter()
                .copied()
                .filter(|player| *player != preferred_player),
        );

        for player in &players {
            if gen_ref.load(std::sync::atomic::Ordering::Relaxed) != gen {
                crate::logger::warn(
                    "Lyrics",
                    &format!("rust-api: fallback abort gen={} (stale)", gen),
                );
                return None;
            }
            crate::logger::info(
                "Lyrics",
                &format!("rust-api: fallback trying '{}'", player.display_name()),
            );
            match smtc_lyrics::get_lyrics_with_player(
                player,
                title,
                artist_opt,
                album_opt,
                album_artist_opt,
                duration_ms_u32,
            )
            .await
            {
                Ok(data) if !data.lines.is_empty() => {
                    let meta = data.track_metadata.as_ref();
                    crate::logger::info(
                        "Lyrics",
                        &format!(
                            "rust-api: raw from='{}' lines={} file={:?} meta={:?}",
                            player.display_name(),
                            data.lines.len(),
                            data.file
                                .as_ref()
                                .map(|f| format!("{:?}/{:?}", f.lyrics_type, f.sync_type)),
                            meta
                        ),
                    );
                    return Some(data);
                }
                Ok(_) => {
                    crate::logger::warn(
                        "Lyrics",
                        &format!(
                            "rust-api: player='{}' returned no lyric lines",
                            player.display_name()
                        ),
                    );
                }
                Err(e) => {
                    crate::logger::warn(
                        "Lyrics",
                        &format!(
                            "rust-api: fallback player='{}' failed: {}",
                            player.display_name(),
                            e
                        ),
                    );
                }
            }
        }

        crate::logger::warn("Lyrics", "rust-api: all sources exhausted");
        None
    })
}

fn line_end_ms(
    data: &LyricsData,
    sorted_indices: &[usize],
    sorted_pos: usize,
    start_ms: i64,
) -> i64 {
    let line = &data.lines[sorted_indices[sorted_pos]];
    if line.duration > 0 {
        return start_ms + i64::from(line.duration);
    }
    if sorted_pos + 1 < sorted_indices.len() {
        return i64::from(data.lines[sorted_indices[sorted_pos + 1]].start_time);
    }
    start_ms + 4000
}

fn tokens_from_line(
    line: &lyrix::models::LineInfo,
    line_start_ms: i64,
    line_end_ms: i64,
) -> Vec<LyricToken> {
    if !line.syllables.is_empty() {
        let mut tokens = Vec::with_capacity(line.syllables.len());
        for (i, s) in line.syllables.iter().enumerate() {
            if s.text.is_empty() {
                continue;
            }
            let start = line_start_ms + i64::from(s.start_time);
            let mut end = if s.duration > 0 {
                start + i64::from(s.duration)
            } else if i + 1 < line.syllables.len() {
                line_start_ms + i64::from(line.syllables[i + 1].start_time)
            } else {
                line_end_ms
            };
            if end < start {
                end = start;
            }
            if end > line_end_ms {
                end = line_end_ms;
            }
            tokens.push(LyricToken {
                text: s.text.clone(),
                start_ms: start,
                end_ms: end,
            });
        }
        if !tokens.is_empty() {
            return tokens;
        }
    }

    // For LRC lyrics (no syllables), return empty tokens
    // to prevent character-by-character highlighting
    Vec::new()
}

fn lyrics_data_to_lyric_lines(data: &LyricsData) -> Vec<LyricLine> {
    let mut indices: Vec<usize> = data
        .lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let effective_text = if l.text.trim().is_empty() {
                l.syllables
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<String>()
            } else {
                l.text.clone()
            };
            if effective_text.trim().is_empty() {
                None
            } else {
                Some(i)
            }
        })
        .collect();
    indices.sort_by_key(|&i| data.lines[i].start_time);

    let mut out = Vec::with_capacity(indices.len());
    for (pos, idx) in indices.iter().enumerate() {
        let line = &data.lines[*idx];
        let start_ms = i64::from(line.start_time);
        let end_ms = line_end_ms(data, &indices, pos, start_ms);
        let text = if line.text.trim().is_empty() {
            line.syllables
                .iter()
                .map(|s| s.text.as_str())
                .collect::<String>()
        } else {
            line.text.clone()
        };
        out.push(LyricLine {
            time_ms: start_ms,
            end_time_ms: end_ms,
            text,
            tokens: tokens_from_line(line, start_ms, end_ms),
        });
    }
    out
}

pub(crate) fn fetch_lyrics_parallel(
    title: &str,
    artist: &str,
    album_title: &str,
    album_artist: &str,
    app_id: &str,
    duration_ms: i64,
    genre: &str,
    gen_ref: std::sync::Arc<std::sync::atomic::AtomicU64>,
    gen: u64,
) -> Option<Vec<LyricLine>> {
    crate::logger::info("Lyrics", &format!(
        "\nlyric-fetch: song='{}' artist='{}' album='{}' album_artist='{}' duration_ms={} genre='{}'",
        title, artist, album_title, album_artist, duration_ms, genre
    ));
    crate::logger::info(
        "Lyrics",
        &format!("rust-api: enabled, title='{}' artist='{}'", title, artist),
    );
    if let Some(data) = fetch_lyrics_by_rust_api(
        title,
        artist,
        album_title,
        album_artist,
        app_id,
        duration_ms,
        &gen_ref,
        gen,
    ) {
        return Some(lyrics_data_to_lyric_lines(&data));
    }
    crate::logger::warn("Lyrics", "rust-api: failed, Nothing to return");
    None
}

/// 获取当前播放位置周围的歌词行（前2行、当前行、后2行）
pub(crate) fn get_nearby_lyrics(lyrics: &[LyricLine], position_ms: i64) -> Vec<(String, bool)> {
    if lyrics.is_empty() {
        return Vec::new();
    }

    // Find current line index
    let mut current_idx: Option<usize> = None;
    for (i, line) in lyrics.iter().enumerate() {
        if line.time_ms <= position_ms {
            current_idx = Some(i);
        } else {
            break;
        }
    }

    let current_idx = match current_idx {
        Some(i) => i,
        None => {
            // Before first lyric line (intro/prelude): show first 5 lines as preview
            return lyrics
                .iter()
                .take(5)
                .map(|line| (line.text.clone(), false))
                .collect();
        }
    };

    let start = current_idx.saturating_sub(2);
    let end = (current_idx + 3).min(lyrics.len());
    let result = (start..end)
        .map(|i| (lyrics[i].text.clone(), i == current_idx))
        .collect();
    result
}
