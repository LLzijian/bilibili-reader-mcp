# 复用已有的本地转写模型

字幕优先；仅在 fallback_to_asr 或 force_asr 被启用时运行转写。保留 setup 安装 faster-whisper 的方式，也支持本机已有的 MOSS、Whisper、FunASR 等程序。接入方式是本地命令适配器，不会替你下载或重新安装模型。

在 ~/.bilibili-mcp/transcriber.json 创建配置，或用 BILIBILI_TRANSCRIBER_CONFIG 指定文件的绝对路径：

~~~json
{"command":"/absolute/path/to/python","args":["/absolute/path/to/adapter.py","--audio","{audio}"]}
~~~

Windows 路径可写成 C:/models/environment/Scripts/python.exe。command 必须是存在的绝对可执行文件路径，args 是参数数组；{audio} 替换为本次下载的音频路径。使用已有虚拟环境时直接指定其中的 Python。程序没有 shell 展开，不要把整条命令放在 command 中。只有本机配置能指定程序，MCP 参数与视频内容不能指定命令。

配置有效时，交互 setup 会跳过 faster-whisper 安装。doctor --json 的 local_transcriber.configured 表示配置通过检查，inference_verified=false 表示 doctor 未执行模型。实际转写成功才说明推理链路可用。配置错误会直接报告，不会悄悄切换到另一模型。

## 输出协议

标准输出只能写 UTF-8 NDJSON（每行一个 JSON 对象）。模型日志写标准错误，不混入字幕：

~~~jsonl
{"type":"meta","language":"zh"}
{"type":"segment","start":0.0,"end":2.5,"text":"第一段讲解"}
{"type":"segment","start":2.5,"end":5.0,"text":"第二段讲解"}
{"type":"done","count":2}
~~~

language 可为 null；时间以秒计，必须有限且非负，end ≥ start，按 start 升序；done.count 必须等于 segment 数量。无识别结果可输出 count=0。异常时返回非零退出码。

与自带转写共用：单任务并发、最长两小时音频、128 MiB 下载上限、30 分钟进程超时、2 MiB 标准输出上限、最多 10000 段。取消和超时会结束进程树。MCP 不返回程序的原始错误日志。子进程使用精简环境，不传递 B 站 Cookie、API token 或代理密钥；模型路径等信息请放在参数或专用设置文件中。自带 Whisper 有额外的内存限制；自定义程序的模型显存与内存由用户管理。

## 本机已有 moss-transcribe 时

examples/moss_adapter.py 可将已有 moss-transcribe 的 batch.py 输出的 SRT 转成上述协议。要求本机已安装并配置 moss-transcribe，不包含模型或安装器：

~~~json
{
  "command":"/absolute/path/to/python",
  "args":[
    "/absolute/path/to/video-reader-mcp/examples/moss_adapter.py",
    "--script","/absolute/path/to/moss-transcribe/scripts/batch.py",
    "--settings","/absolute/path/to/moss-settings.json",
    "--audio","{audio}"
  ]
}
~~~

适配器用同一个 Python 调用 batch.py，设置文件中的模型工作环境与路径由原工具管理。原始音频与 SRT 随本次临时目录一起清理；moss-transcribe 自己的缓存与失败检查点遵循原有设置。其他模型也可按同一协议编写轻量适配器。
