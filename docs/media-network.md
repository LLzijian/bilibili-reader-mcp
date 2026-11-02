# 媒体下载与 Fake-IP

默认 BILIBILI_MEDIA_DNS=system，沿用系统 DNS。工具检查媒体域名的所有解析结果，拒绝私网、回环与保留地址，然后将 HTTPS 请求固定到已核实的公网地址，同时保留原域名的 TLS 验证。视频地址或 Cookie 不发送给 DNS 服务。

部分 TUN 代理返回 198.18.0.0/15 或 2001:2::/48 内的 Fake-IP。工具会停止下载并报告 ASR_FAKE_IP_DNS，不能简单放行这些地址。字幕与评论接口可能仍然正常。

可选处理方式：在代理中为 +.bilivideo.com 与 +.bilivideo.cn 设置 fake-ip-filter，或经用户同意为本工具启用：

~~~json
{"env":{"BILIBILI_MEDIA_DNS":"cloudflare"}}
~~~

这是 MCP 服务配置中的 env；将它合并到该服务的 command、args 旁。该选项只为允许的 B 站媒体域名发送 Cloudflare DoH 的 A 记录查询，不发送 Cookie、播放签名地址或视频内容。DNS 回复仍必须全部为公网地址，下载仍使用原有域名白名单、HTTPS、重定向与体积上限。查询失败会停止，不会退回 Fake-IP 或放宽校验。不会修改系统 DNS、TUN 或代理配置。

[Cloudflare 官方 JSON DoH 文档](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)。此功能默认关闭；agent 在修改用户网络配置或启用公共解析前，应先取得用户明确选择。
