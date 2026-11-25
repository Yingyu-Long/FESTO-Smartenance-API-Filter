export type Language = "en" | "zh";

const chinese: Record<string, string> = {
  "PostgreSQL database": "PostgreSQL 数据库",
  "Sync all machines": "同步全部设备",
  "Syncing…": "正在同步…",
  "Syncing database": "正在同步数据库",
  "Last full sync (UTC+8)": "本次会话上次完整同步（北京时间）",
  "Next scheduled sync (UTC+8)": "下次自动同步（北京时间）",
  "Last scheduled sync (UTC+8)": "上次自动同步（北京时间）",
  "Refreshing Smartenance session…": "正在续签 Smartenance 登录会话…",
  "Refreshed token belongs to a different Smartenance account. Sync stopped.": "续签后的令牌属于另一个 Smartenance 账号，已停止同步。",
  "Scheduled sync succeeded": "自动同步成功",
  "Scheduled sync running": "正在执行自动同步",
  "Scheduled sync failed": "自动同步失败",
  "Oldest snapshot (UTC+8)": "最早数据读取时间（北京时间）",
  "Queries use saved data first. Missing machines are fetched from Festo and saved automatically. Sync refreshes all accessible machines, including existing incidents and new repairs.":
    "查询优先读取数据库，未缓存的设备自动从 Festo 获取并保存。同步会更新全部可访问设备，包括已有故障和新增维修任务。",
  "Saved data reflects the last successful read. Sync before querying when you need the latest changes.":
    "数据库保存的是上次成功读取的数据。需要最新修改时，请先同步再查询。",
  "Completed machines are saved as sync progresses.": "每台设备完整读取成功后保存到数据库。",
  "Sync cancelled. Completed machines were saved; unfinished machines keep their previous data.": "同步已取消。已完成的设备已保存，未完成的设备保留原数据。",
  "Sync did not finish. Completed machines were saved; unfinished machines keep their previous data.": "同步未全部完成。已完成的设备已保存，未完成的设备保留原数据。",
  "PostgreSQL is unavailable. Check DATABASE_URL and the database service, then try again.": "无法连接或写入 PostgreSQL，请检查 DATABASE_URL 和数据库服务后重试。",
  "Configure DATABASE_URL to enable the PostgreSQL database.": "请配置 DATABASE_URL 以启用 PostgreSQL 数据库。",
  "The database snapshot is incomplete. Please sync again.": "数据库中的设备数据不完整，请重新同步。",
  "The operation did not finish. Please try again.": "操作未完成，请重试。",
  "Repair data export": "维修数据导出",
  "Company logo": "公司标志",
  "REPAIR TASKS / CSV": "维修任务 / CSV",
  "Repair task export": "维修任务导出",
  "Select machines and creation dates to export repair records as CSV.":
    "选择设备和创建日期，将维修记录导出为 CSV。",
  "Select machines and creation dates to export repair tasks from closed incidents.":
    "选择设备和创建日期，导出已关闭故障下的维修任务。",
  "Connected to Smartenance": "已连接 Smartenance",
  "Not connected": "未连接",
  "Connect to Smartenance": "连接 Smartenance",
  Disconnect: "断开连接",
  "Credentials are used only for this page session. Reconnect after refreshing the page.":
    "凭证仅用于当前页面会话。刷新页面后需重新连接。",
  "Access token": "访问令牌",
  "API account": "API 账号",
  "Paste your access token (Bearer prefix optional)": "粘贴访问令牌（可包含 Bearer 前缀）",
  "Connect & load machines": "连接并加载设备",
  "API username": "API 用户名",
  "Smartenance Premium API username": "Smartenance Premium API 用户名",
  Password: "密码",
  "Sign in & load machines": "登录并加载设备",
  "Trouble signing in?": "无法登录？",
  "Use an account with API access. The official guide and example list different authentication policies. If the default does not work, select the alternative manually or use an access token.":
    "请使用具有 API 权限的账号。官方指南与示例使用不同的认证策略；如默认策略无效，请手动选择另一个策略，或使用访问令牌。",
  "Authentication policy": "认证策略",
  "Festo authentication guide ↗": "Festo 认证指南 ↗",
  Filters: "筛选条件",
  "Machines · select one or more": "设备 · 可单选或多选",
  "Select machines": "选择设备",
  "Add another…": "继续添加…",
  "Search by machine name or number": "按设备名称或编号搜索",
  "No machines found": "未找到设备",
  "Select all": "全选",
  Clear: "清空",
  "All statuses": "全部状态",
  Open: "待处理（Open）",
  "In progress (InWork)": "处理中（InWork）",
  Closed: "已关闭（Closed）",
  "Created from": "创建开始日期",
  "Created through": "创建结束日期",
  "Searching…": "正在查询…",
  "Find repair tasks": "查询维修任务",
  "Data read at (UTC+8)": "读取完成时间（北京时间）",
  "Filtered from the last completed query. Click Find repair tasks to refresh.":
    "已从上次完整查询结果中筛选。点击“查询维修任务”可重新读取最新数据。",
  "Try other machines, dates, or incident statuses.": "请调整设备、日期或故障状态。",
  "Filtered by repair task creation time · UTC+8 (Beijing) · Both dates included":
    "按维修任务创建时间筛选 · 北京时间 UTC+8 · 包含起止日期全天",
  "Closed incidents only · All repair results included":
    "仅查询已关闭故障（Closed）· 包含所有维修结果",
  Cancel: "取消",
  Results: "查询结果",
  "Each row is a repair task linked to an incident.": "每行对应故障记录下的一个维修任务。",
  "Export all to CSV": "全部导出为 CSV",
  "Machine / incident": "设备 / 故障",
  "Repair task": "维修任务",
  Result: "维修结果",
  "Created at (UTC+8)": "创建时间（UTC+8）",
  "Created by": "创建人",
  "Unnamed machine": "未命名设备",
  "No machine number": "无设备编号",
  "No task description": "无任务描述",
  "No incident summary": "无故障摘要",
  "Not recorded": "未记录",
  Success: "成功",
  Failure: "失败",
  "Result pages": "结果分页",
  Previous: "上一页",
  Next: "下一页",
  "Collecting repair records": "正在读取维修记录",
  "No repair tasks match these filters": "没有符合筛选条件的维修任务",
  "No repair tasks in closed incidents match these filters":
    "已关闭故障中没有符合筛选条件的维修任务",
  "Your repair records, ready to export": "查询并导出维修记录",
  "Export becomes available once all records have been read.": "读取全部记录后即可导出。",
  "Try other machines or a wider creation date range.": "请尝试选择其他设备或扩大创建日期范围。",
  "Connect your account, then select machines and a date range to begin.":
    "连接账号后，选择设备和日期范围即可开始。",
  "Festo AX Smartenance · Read and export repair records":
    "Festo AX Smartenance · 查询和导出维修记录",
  "API documentation ↗": "API 文档 ↗",
  "Connection failed. Please try again.": "连接失败，请重试。",
  "Connected, but this account has no accessible machines.": "已连接，但该账号没有可访问的设备。",
  "Unable to connect. Check that the local application is running and the network is available.":
    "无法连接，请检查本地程序是否正在运行以及网络是否可用。",
  "Another operation is in progress. Please wait.": "另一个操作正在进行，请稍候。",
  "Connect to Smartenance first.": "请先连接 Smartenance。",
  "A selected machine is unavailable.": "所选设备不可用。",
  "Reading incidents for the selected machines…": "正在读取所选设备的故障记录…",
  "Loading machines…": "正在加载设备列表…",
  "Query failed.": "查询失败。",
  "The server did not return any query results.": "服务器未返回查询结果。",
  "The query did not finish. Please try again. Partial results cannot be exported.":
    "查询未完成，请重试。无法导出不完整的结果。",
  "Query cancelled. Partial results were discarded.": "查询已取消，已丢弃不完整的结果。",
  "The query was interrupted. Please try again.": "查询中断，请重试。",
  "Complete a query with matching results before exporting.":
    "请先完成查询并获得匹配结果，再进行导出。",
  "Select valid start and end dates.": "请选择有效的起止日期。",
  "This date does not exist. Choose another date.": "日期不存在，请选择其他日期。",
  "The start date cannot be after the end date.": "开始日期不能晚于结束日期。",
  "Select at least one valid machine.": "请至少选择一台有效设备。",
  "Select a start and end date.": "请选择起止日期。",
  "Select a valid incident status.": "请选择有效的故障状态。",
  "The access token has expired or is invalid. Reconnect to continue. This request will not be retried automatically.":
    "访问令牌已过期或无效，请重新连接。此请求不会自动重试。",
  "Festo has limited the request rate.": "Festo 已限制请求频率。",
  "Festo did not respond in time. Please try again.": "Festo 响应超时，请重试。",
  "Unable to connect to Festo. Check the connection and try again.":
    "无法连接 Festo，请检查网络后重试。",
  "Query cancelled.": "查询已取消。",
  "The connection was interrupted or the response was invalid. Please try again.":
    "连接中断或响应无效，请重试。",
  "Enter your API access token.": "请输入 API 访问令牌。",
  "The access token format is invalid.": "访问令牌格式无效。",
  "Festo returned an unreadable response. No results were exported.":
    "无法读取 Festo 响应，未导出任何结果。",
  "A machine or incident no longer exists. Run the query again.":
    "设备或故障记录已不存在，请重新查询。",
  "Festo did not return the complete machine list. Reconnect to try again.":
    "Festo 未返回完整设备列表，请重新连接。",
  "Festo returned duplicate or invalid machines. Reconnect to try again.":
    "Festo 返回了重复或无效的设备，请重新连接。",
  "Enter your Smartenance Premium API username and password.":
    "请输入 Smartenance Premium API 用户名和密码。",
  "The authentication policy is invalid.": "认证策略无效。",
  "Unable to connect to the Smartenance sign-in service. Check the connection.":
    "无法连接 Smartenance 登录服务，请检查网络。",
  "Failed to fetch": "网络请求失败，请检查本地程序和网络连接。",
  "Machine name": "设备名称",
  "Machine number": "设备编号",
  "Machine ID": "设备 ID",
  "Incident number": "故障编号",
  "Incident ID": "故障 ID",
  "Incident summary": "故障摘要",
  "Incident status": "故障状态",
  "Incident occurred at (UTC+8)": "故障发生时间（UTC+8）",
  "Incident fixed at (UTC+8)": "故障修复时间（UTC+8）",
  "Incident description": "故障描述",
  "Incident cause": "故障原因",
  "Repair task ID": "维修任务 ID",
  "Repair task description": "维修任务描述",
  "Repair result": "维修结果",
  "Task created at (UTC+8)": "任务创建时间（UTC+8）",
  "Task created by": "任务创建人",
  "Task modified at (UTC+8)": "任务修改时间（UTC+8）",
  "Task modified by": "任务修改人",
  "Task comments (JSON)": "任务评论（JSON）",
  "Repair content": "维修内容",
  "Repair time": "维修时间",
  "Repair labor hours": "维修工时",
  Downtime: "停机时间",
  Remarks: "备注",
  "Repair owner": "维修负责人",
  Collaborators: "协作人员",
  "Enter an API access token.": "请输入 API 访问令牌。",
  "Festo returned an unexpected redirect. The request was stopped to protect your credentials.":
    "Festo 返回了意外的重定向，为保护凭证已停止请求。",
  "The Festo pagination response is invalid. The query stopped to avoid missing records.":
    "Festo 分页响应无效，为避免遗漏记录已停止查询。",
  "The record count changed during the query. Run it again to obtain complete results.":
    "查询期间记录总数发生变化，请重新查询以获取完整结果。",
  "Festo returned an incomplete page. Run the query again.": "Festo 返回的分页不完整，请重新查询。",
  "A page contains duplicate or invalid records. Run the query again.":
    "分页包含重复或无效记录，请重新查询。",
  "This machine has more than 100,000 records. Contact your administrator to use the bulk export API.":
    "该设备超过 100,000 条记录，请联系管理员使用批量导出 API。",
  "The Smartenance sign-in service returned an unexpected redirect. Sign-in was stopped.":
    "Smartenance 登录服务返回了意外的重定向，已停止登录。",
  "A selected machine no longer exists or is inaccessible. Reconnect to reload machines.":
    "所选设备已不存在或无法访问，请重新连接并加载设备。",
  "Festo returned an incident for a different machine. The query was stopped.":
    "Festo 返回了其他设备的故障记录，已停止查询。",
  "The incident details are invalid. The query stopped to avoid missing tasks.":
    "故障详情无效，为避免遗漏任务已停止查询。",
  "A repair task has an invalid ID or creation time and cannot be filtered reliably.":
    "维修任务的 ID 或创建时间无效，无法准确筛选。",
  "Festo returned a duplicate repair task. Run the query again.":
    "Festo 返回了重复的维修任务，请重新查询。",
  "More than 100,000 tasks matched. Select fewer machines or a shorter date range.":
    "匹配任务超过 100,000 条，请减少设备或缩小日期范围。",
  "This access address is not allowed. Contact the administrator to configure the server address.":
    "当前访问地址未获允许，请联系管理员配置服务器访问地址。",
  "The server access address configuration is invalid.": "服务器访问地址配置无效，请联系管理员。",
  "Only requests from this application are accepted.": "仅接受来自本程序的请求。",
  "The request format is invalid.": "请求格式无效。",
  "The request body is empty.": "请求内容为空。",
  "The request body is too large.": "请求内容过大。",
  "The request body is invalid.": "请求内容无效。",
  "Bulk export unavailable for this machine. Using the standard query.": "此设备的批量导出不可用，正在自动使用标准查询。",
  "Select a connection method.": "请选择连接方式。",
};

export function translate(text: string, language: Language): string {
  if (language === "en" || !text) return text;
  if (chinese[text]) return chinese[text];
  const patterns: [RegExp, (...args: string[]) => string][] = [
    [/^Database: (\d+) machines$/, (_, n) => `数据库读取：${n} 台设备`],
    [/^Reading database for (.+)…$/, (_, name) => `正在从数据库读取 ${name}…`],
    [/^Updating database for (.+)…$/, (_, name) => `正在从 Festo 读取并更新 ${name}…`],
    [/^Loading complete machine data: (\d+) incidents read\.$/, (_, n) => `正在读取设备完整数据，已读取 ${n} 条故障。`],
    [/^Synced (\d+) of (\d+) machines · (\d+) incidents\.$/, (_, n, total, incidents) => `已同步 ${n} / ${total} 台设备，共 ${incidents} 条故障。`],
    [
      /^Sync complete: (\d+) machines · (\d+) incidents \(\+(\d+) new · ~(\d+) updated · =(\d+) unchanged · -(\d+) removed\)\.$/,
      (_, n, incidents, ins, upd, unch, del) =>
        `同步完成：${n} 台设备，共 ${incidents} 条故障（新增 ${ins} · 更新 ${upd} · 未变 ${unch} · 移除 ${del}）。`,
    ],
    [/^Sync complete: (\d+) machines · (\d+) incidents\.$/, (_, n, incidents) => `同步完成：${n} 台设备，共 ${incidents} 条故障。`],
    [
      /^\+(\d+) new · ~(\d+) updated · =(\d+) unchanged · -(\d+) removed$/,
      (_, ins, upd, unch, del) => `新增 ${ins} · 更新 ${upd} · 未变 ${unch} · 移除 ${del}`,
    ],
    [
      /^Auto-sync enabled: day (.+) of each month at (.+) \(UTC\+8\)$/,
      (_, days, time) => `服务端自动增量同步已启用：每月 ${days} 日 ${time}（北京时间）`,
    ],
    [/^Connected\. Loaded (\d+) machines\.$/, (_, n) => `已连接，已加载 ${n} 台设备。`],
    [
      /^Loaded (\d+) machines\. Reconnect when your access token expires\.$/,
      (_, n) => `已加载 ${n} 台设备。访问令牌过期后请重新连接。`,
    ],
    [/^(\d+) selected$/, (_, n) => `已选择 ${n} 台`],
    [
      /^Created a CSV with (\d+) repair tasks\. Check your browser downloads\.$/,
      (_, n) => `已生成包含 ${n} 个维修任务的 CSV，请查看浏览器下载。`,
    ],
    [/^Reading incidents for (.+)…$/, (_, name) => `正在读取 ${name} 的故障记录…`],
    [/^Reading bulk export for (.+)…$/, (_, name) => `正在批量读取 ${name} 的故障及维修记录…`],
    [/^Bulk export failed \((\d+)\)\. Using the standard query\.$/, (_, status) => `批量导出失败（${status}），正在自动使用标准查询。`],
    [/^Bulk export: (\d+) machines · Standard query: (\d+) machines$/, (_, bulk, standard) => `批量导出：${bulk} 台设备 · 标准查询：${standard} 台设备`],
    [
      /^Checked (\d+) incidents\. Found (\d+) matching repair tasks\.$/,
      (_, n, count) => `已检查 ${n} 条故障记录，找到 ${count} 个匹配的维修任务。`,
    ],
    [
      /^Checked (\d+) incidents\. Found (\d+) repair tasks in closed incidents\.$/,
      (_, n, count) => `已检查 ${n} 条故障记录，在已关闭故障中找到 ${count} 个维修任务。`,
    ],
    [
      /^Festo rate limit reached\. Waiting at least (\d+) seconds, then resuming automatically\. You can cancel this query\.$/,
      (_, n) => `Festo 已限流，将等待至少 ${n} 秒后自动继续。你可以取消查询。`,
    ],
    [
      /^Festo is (?:still rate limited|rate limited)\. Please wait at least (\d+) seconds before trying again\.(.*)$/,
      (_, n) => `Festo 仍处于限流状态，请等待至少 ${n} 秒后重试。未导出不完整结果。`,
    ],
    [
      /^(.+) — (.+) · (\d+) incidents checked$/,
      (_, from, to, n) => `${from} — ${to} · 已检查 ${n} 条故障记录`,
    ],
    [
      /^20 rows per page · CSV includes all (\d+) rows$/,
      (_, n) => `每页 20 条 · CSV 包含全部 ${n} 条记录`,
    ],
    [
      /^(Connection setup|Account sign-in|Token validation|Loading machines) failed: (.*)$/,
      (_, stage, message) =>
        `${({ "Connection setup": "连接", "Account sign-in": "账号登录", "Token validation": "令牌验证", "Loading machines": "加载设备" } as Record<string, string>)[stage]}失败：${translate(message, language)}`,
    ],
    [
      /^Festo denied access\. Check API account permissions or access restrictions\.(.*)$/,
      (_, wait) =>
        `Festo 拒绝访问，请检查 API 账号权限或访问限制。${translate(wait.trim(), language)}`,
    ],
    [
      /^Please wait at least (\d+) seconds before trying again\.$/,
      (_, n) => `请等待至少 ${n} 秒后重试。`,
    ],
    [
      /^Festo returned an error \((\d+)\) while (loading machines|reading bulk export|downloading bulk export|loading custom fields|reading incident list|reading incident details|reading API data)\. No results were exported\.$/,
      (_, status, operation) => `${({
        "loading machines": "加载设备列表",
        "reading bulk export": "读取批量导出",
        "downloading bulk export": "下载批量导出文件",
        "loading custom fields": "加载自定义栏位",
        "reading incident list": "读取故障列表",
        "reading incident details": "读取故障详情",
        "reading API data": "读取 API 数据",
      } as Record<string, string>)[operation]}时 Festo 返回错误（${status}），未导出任何结果。`,
    ],
    [
      /^Festo returned an error \((\d+)\)\. No results were exported\.$/,
      (_, n) => `Festo 返回错误（${n}），未导出任何结果。`,
    ],
    [
      /^Smartenance sign-in failed \((\d+)\)\.(.*)$/,
      (_, n) => `Smartenance 登录失败（${n}）。请检查 API 账号、密码和认证策略，或使用访问令牌。`,
    ],
  ];
  for (const [pattern, render] of patterns) {
    const match = text.match(pattern);
    if (match) return render(...match);
  }
  return text;
}
