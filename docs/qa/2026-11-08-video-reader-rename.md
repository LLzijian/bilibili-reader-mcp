# Video Reader MCP 更名验收（2026-11-08）

项目显示名为 Video Reader MCP，仓库与首选 CLI 为 `video-reader-mcp`，包名为 `@llzijian/video-reader-mcp`。旧 CLI 别名、`~/.bilibili-mcp/` 配置目录、`BILIBILI_*` 环境变量、现有工具名与 `study_video` prompt 保持兼容。

## 验证结果

- `npm run verify:local` 退出码为 0：77 个测试文件，1650 项通过、3 项跳过，共 1653 项。
- TypeScript 构建通过，包内容检查通过，共 299 个文件。
- 验证进程显式配置 FFmpeg 与 ffprobe，实际执行合成媒体的音频提取、关键帧和 MP4 片段测试；未修改用户持久配置。
- CLI、MCP stdio 启动与服务器身份、包和 lockfile 一致性、新包更新检查及 npm 未发布时的提示均有测试覆盖。
- 中英文 README 使用新的 SVG 横幅，更新安装、客户端配置、平台能力、示例、资源上限及旧名兼容说明。
- 包保持 `private: true`；本次未发布 npm 包或 GitHub Release。

## 真实平台范围

本轮更名验收未新增真实平台或模型推理验证。先前多平台验收的真实 Bilibili 元数据读取、媒体下载受 Fake-IP DNS 限制、抖音尚未完成真实线上样本验证等边界，继续见[多平台验收记录](2026-11-07-multiplatform-video.md)。合成媒体测试通过不能替代真实抖音访问或 ASR 模型效果验证。
