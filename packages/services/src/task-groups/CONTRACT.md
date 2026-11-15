# 任务分组

控制端 Host 独占写入跨 workspace 分组组织态，复用 tasks-index 的旧分组表。
CLI 和远端项目服务不接收 Group。结构读取无副作用，任务内容来自现有 Host 树。

move 是单节点相对位置命令：来源和目标锚点在事务中复检，不以可见快照覆盖全库。
所有引用按 canonical workspace identity 与 taskId 隔离，服务校验 Host 身份和任务事实。
远端离线不删成员，不通过分组服务建立连接。取消组保留全部任务及成员顺序。

普通 Host（包括显式 local 装配）仍要求 identity authority 与 hostId 相等。非 local 的独立 Source 的 hostId 由可信装配限定，
历史 canonical identity 必须与所属 Host 原始树中的任务/已删除事实、真实目录精确匹配；不新增身份登记路径。

Source attachment 出站分组结构的 members.workspaceKey 和 order.key 使用一致 stable identity。
order.key 仅在分组结构中按既有 JSON 二元组 grammar 转译已登记 workspaceKey，taskId 和持久化 key 不变。

admit 只登记首次出现或首次系统类型标记；独立加法表记录是否已被用户整理和创建 receipt，
防止重复刷新覆盖手动移出或迟到创建回包覆盖后续整理。登记状态不复制会话事实。
所有写入提交后广播 state:task-groups；失败不广播，客户端沿用已接受结构并刷新。

规格：docs/ui/task-grouped-view.md。桌面 continuous 与手机 replayable 复用同一组织 owner。
