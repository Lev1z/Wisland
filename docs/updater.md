# 应用内更新

设置 → 关于提供自动检查开关、立即检查、确认安装。启动延迟 10 秒检查，自动网络检查最多每天一次；每小时仅判断是否到期。手动检查不受此限制。只检查稳定新版，检查不下载或执行安装程序。

显示版本与说明后，下载按钮仍需第二次确认。下载进度在设置显示，官方 Tauri updater 校验签名后才运行安装程序；安装时 Wisland 退出，Codex 与其他应用不退出。网络、清单或签名失败均保留当前版本。0.2.2 用户需手动安装首个带更新功能的正式版本一次。

更新源固定为本仓库 GitHub Releases 的 `latest.json`，安装包地址限制在本仓库对应版本资产。公钥内置，私钥绝不能提交、打印或上传为 Release 资产。更新签名不等于 Windows Authenticode，不会自动消除 SmartScreen 提示。

本机私钥：`%LOCALAPPDATA%\Wisland\release-signing\updater.key`；公钥为同路径 `.pub`。目录访问限制为当前用户。请另行安全备份私钥，丢失会影响已有客户端后续更新；不要在聊天中粘贴私钥。

本地构建：给构建进程设置 `TAURI_SIGNING_PRIVATE_KEY` 为私钥文件绝对路径，然后运行 `npm run tauri build -- --bundles nsis` 和 `node scripts/create-update-manifest.cjs`。安装包、同名 `.sig` 与 `latest.json` 上传齐全后再公开 Release。不覆盖已公开版本文件。

CI 改为 `v*` 标签，需仓库 Actions secrets `TAURI_SIGNING_PRIVATE_KEY`（私钥内容）及可选密码 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；每版需对应 `docs/releases/v版本.md`。本次未向 GitHub 写入私钥或 Secrets，也未发布新版。缺少签名时 CI 失败，不会降级为不校验的更新。

偏好和检查时间保存在 Wisland 配置目录的 `updates.json`，不保存认证令牌或可执行程序。窗口材质、动画与 Runtime 数据链路不变。首次新版 Release 尚未提供清单时，设置会显示检查失败，可重试或通过 GitHub 手动下载。

原生 QA 使用 `WISLAND_UPDATE_CONFIG_DIR` 单独隔离更新偏好；此变量只改变偏好文件位置，不覆盖更新地址或签名公钥。Windows Known Folders 不跟随 APPDATA 环境变量，不能仅靠 APPDATA 声称隔离全部应用配置。

参考：[Tauri Updater](https://v2.tauri.app/plugin/updater/)。

## 本次验证

67 项 Rust 常规测试、36 组侧栏界面场景、更新设置专项（确认/取消、版本绑定、进度、错误与安全文本）、版本一致性及原生窗口回归通过。签名专项显式运行：最终安装包通过，内存中篡改一字节后被拒绝，没有执行覆盖安装。清单生成在本机验证，GitHub Actions 尚未在线执行，线上端到端升级需首个带签名清单的新版本发布后验证。原生测试的更新偏好使用专用目录，不写入真实用户更新偏好。
