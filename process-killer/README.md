# 进程终结者 (process-killer)

Spark native 插件:一个聚合搜索框找到任意进程并结束它——输入**端口号 / PID / 进程名 / 路径关键词**都能命中,温和结束或强杀一键完成。

## 使用

在 Spark 主输入框输 `kill <关键词>`(或关键字「进程」)回车,带着关键词直接开窗搜索,例如:

- `kill 8080` → 打开即搜 8080
- 页面内:`:8080` 端口占用;`pid:1234` 指定 PID;`port 3000` / `端口 3000`;纯数字 = PID 或端口双查;多个关键词空格分隔(且关系);普通文本按名称/路径子串匹配

每行四个操作:**温和**(taskkill 不带 /F,向 GUI 程序发 WM_CLOSE,给保存机会)、**强杀**(TerminateProcess 立即终止)、复制 exe 路径、打开文件位置。温和未退出时页面会追问「改用强杀」。

## 实现要点

- 形态 `runtime: native`,页面(page.html/page.css/page.js)只做 UI,进程枚举与结束全部经 `spark.rpc` 由 exe 执行。
- **进程枚举**:sysinfo(PID/名称/路径/命令行/内存/启动时间),每次搜索现场刷新。
- **端口→PID**:Win32 `GetExtendedTcpTable` / `GetExtendedUdpTable`(v4+v6,等价 netstat -ano 但无本地化解析问题);只保留 LISTEN / ESTABLISHED / UDP 绑定,TIME_WAIT 等临终 socket 不参与匹配。新版 sysinfo(0.39)已无 `tcp()/udp()`,此处自实现。
- **温和结束**:`taskkill /PID`(无 /F);**强杀**:`OpenProcess(PROCESS_TERMINATE|SYNCHRONIZE)` + `TerminateProcess` + `WaitForSingleObject` 确认退出;错误码映射人话(如 `ERROR_ACCESS_DENIED` → 「权限不足,目标可能以管理员运行」)。
- **保护名单**(无条件拒绝):csrss / smss / wininit / winlogon / lsass / services / Registry / Memory Compression,以及 pid 0/4 与插件自身进程。

## RPC 方法(plugin.page)

| method | args | result |
|---|---|---|
| `search` | `{ q }` | `{ rows: [{pid,name,exe,cmd,mem,start_time,parent,ports:[{proto,addr,port,state}],ports_more,tags}], total, procs_total, took_ms, self_pid }` |
| `kill` | `{ pid, mode: "graceful"\|"force" }` | `{ ok, exited, detail }`(graceful 未退出时 exited=false,由页面追问强杀) |
| `locate` | `{ pid }` | `{ ok }` — explorer /select 定位 exe 目录 |

## 构建 / 测试

```
cargo test                     # 查询解析单测
cargo build                    # 先出 target/debug exe(冒烟要 spawn 它)
cargo run --example smoke      # 协议/搜索/杀进程安全冒烟(自绑端口+自建子进程,不碰真实系统进程)
cargo build --release          # 出发布 exe
# 复制 target/release/spark-plugin-process-killer.exe 到 0.1.0/(文件名与 plugin.json 的 main 一致)
# 再跑一次 cargo run --example smoke —— 发布物 exe 存在时优先冒烟发布物
node --check 0.1.0/page.js
```

冒烟含保护名单验证:把 cmd.exe 复制改名 `csrss.exe` 放进 `target/smoke-fixture/` spawn 起来,只验证 kill 被名单拒绝,不真杀,跑完自清。

## 已知边界

- 宿主以普通用户运行时,**管理员/系统级进程杀不掉**(报「权限不足」)——宿主无 UAC/提权机制,不做承诺。
- 部分系统进程的命令行(`cmd()`)取不到,显示为空,不阻塞搜索。
- 温和结束对无窗口进程(服务/控制台程序)无效,页面明示后可改强杀。
- 仅 Windows(Win32 API 依赖)。
- 关键字:`kill` / `进程`;开发阶段只在 `0.1.0/` 迭代。