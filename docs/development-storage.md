# 开发目录占用与清理

2026-11-10 发布构建后，本机项目目录约 23.1 GiB。主要是重复调试、测试和链接生成的缓存，并非软件安装体积，也不是 Git 上传的源码体积。数值随之后的构建变化。

| 路径 | 当时占用 | 清理影响 |
| --- | ---: | --- |
| `src-tauri/target/debug` | 18.93 GiB | 全部可重建；删除后下一次 Rust 调试 / 测试较慢 |
| ↳ `incremental` | 7.67 GiB | 增量编译缓存，可单独清理；已生成的 EXE 不受影响 |
| ↳ `deps` | 8.01 GiB | 编译依赖及调试符号；建议随整个 debug 清理，不挑文件删除 |
| ↳ `build` | 1.55 GiB | 依赖构建产物；可重建 |
| `src-tauri/target/release` | 3.40 GiB | 可重建；删除前另存需要保留的安装包和签名 |
| 根目录 `target` | 约 0.69 GiB | 旧 preview EXE、截图、合成 JSONL fixture、WebView2 测试配置、测试工具；可清理，界面测试依赖需重装 |
| `node_modules` | 约 62 MiB | 可通过 `npm ci` 重装 |
| `dist` | 不到 1 MiB | 可通过 `npm run build` 重建 |
| `.git` | 约 4 MiB | 必须保留版本历史，不作为缓存清理 |

这些条目有包含关系，不能把 debug 与它的三个子目录再相加。空间有限时，优先清理 `src-tauri/target/debug/incremental`；不需要保留调试缓存时，可清理整个 debug。不要在构建进行中清理，也不要删除正在运行的测试 EXE。

源码、`public`、`docs`、`scripts`、`.github`、各类 manifest / lock 文件及 `.git` 应保留。用户设置与 Codex 日志不在上述构建缓存内。发布签名私钥位于项目之外的本机受限目录，不能当作缓存删除；丢失后会影响后续签名更新。

`target` 中的 Runtime JSONL、棋盘背景截图等由回归测试创建，不是 Codex 实际会话。清理它们不会删除真实会话。项目的忽略规则已排除构建目录，推送代码不会上传这些大文件。
