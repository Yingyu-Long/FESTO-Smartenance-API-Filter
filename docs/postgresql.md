# PostgreSQL 数据库与同步

页面新增“同步全部设备”按钮。同步不受查询中的设备、状态或日期条件限制，会重新读取账号可访问的全部设备和故障，更新已有故障及维修任务，补充新增记录，并移除完整新快照中已不存在的故障。

普通查询先验证 Festo 令牌和设备访问权限，再按所选设备查数据库。完整设备快照存在时直接读取；不存在时从 Festo 读取整台设备的故障和维修任务，保存成功后再按原来的状态、创建日期筛选。没有故障的设备也会记录完整空快照，避免反复请求。不会把一次日期筛选后的少量结果当作设备全量数据缓存。

数据库内记录代表上次成功读取的数据。已有设备的新增故障、状态及维修修改需要点击同步才会更新。查询结果显示数据库命中设备数量以及所用快照的最早读取时间。每次请求仍需访问 `/machines` 来验证权限；不支持失去 Festo 认证后的离线查询。

## 本机运行（不用 Docker）

本机使用 `embedded-postgres` 提供的原生 PostgreSQL 二进制程序，以独立数据库进程运行，数据持久化到项目的 `.local/postgres`，不是浏览器存储或内存模拟。

本机配置保存于被 Git 忽略的 `.env`。应用与启动脚本均从中读取 `DATABASE_URL`；密码不会发送到浏览器。配置示例见 `.env.example`。

```sh
npm run db:local
npm run dev
```

`db:local` 首次初始化数据目录、创建 `smartenance` 数据库和表，然后启动本机数据库。重复执行会复用已有数据库，不会清空数据。连接地址为 `127.0.0.1:55432`，数据库和用户为 `smartenance`。数据库仅监听本机地址，使用密码认证。

```sh
npm run db:status
npm run db:stop
```

停止后数据仍在；重新运行 `npm run db:local` 即可继续使用。重启电脑后也请先运行此命令。不要删除 `.local/postgres`，这是实际数据库数据。日志位于 `.local/postgres.log`。

如果连接已有 PostgreSQL，将 `DATABASE_URL` 改成其地址后运行 `npm run db:init`，无需运行 `db:local`。初始化仅创建应用自己的表和序列，不清空已有表。

本次不部署 Docker，不启动镜像或容器，保留项目原有 Docker 文件。原 Docker 配置尚未接入本次数据库功能，请使用本地启动命令测试。

原生程序来源：[embedded-postgres 项目](https://github.com/leinelissen/embedded-postgres)。

## 数据结构和一致性

- `smartenance_machines`：账号隔离键、设备 UUID、设备 JSON、快照版本、故障数量、成功读取时间。只有完整成功的设备读取才会写入此表。
- `smartenance_incidents`：账号隔离键、设备 UUID、故障 UUID、完整故障 JSON（包含维修任务、自定义字段及其他 API 返回的详情）。
- `smartenance_snapshot_revision`：读取开始时分配版本，防止较早发起但较晚完成的请求覆盖更新的数据。

每台设备使用同一个 PostgreSQL 连接中的事务更新，写入任何一条记录失败则整体回滚。事务级锁避免同台设备并发写入相互干扰。查询用单条 SQL 读取完整快照，避免读到新旧混合数据；实际记录数与完整性计数不一致时重新从 API 获取。

同步按设备提交。取消或失败时，已经同步成功的设备会保留新数据；未完成设备保留旧快照，下次同步重新读取。API 429 重试与原限流保护仍有效。批量接口不可用时回退标准分页和详情；不对全量缓存应用时间或状态过滤。读取故障详情失败时不能写入不完整快照。

账号隔离键在 Festo 成功验证令牌后由 JWT 的 issuer、subject、audience、tenant 计算哈希；正常令牌续期可复用缓存。无可用身份声明的不透明令牌按完整令牌哈希隔离，换令牌会重新建缓存。数据库不存储原始令牌或密码。每次读取缓存都使用当前授权的设备列表，已经不可访问的设备不会返回。

## 验证

```sh
npm test
npm run test:postgres
npm run typecheck
npm run lint
npm run build
```

`npm test` 中没有配置 `DATABASE_URL` 时会跳过真实数据库测试；`test:postgres` 从 `.env` 读取配置并验证事务回滚、持久化、账号隔离、完整性、版本顺序和空快照。真实数据库测试只操作随机 `test-UUID` 命名空间下的合成数据，完成后清理。

实现参考：[node-postgres 事务](https://node-postgres.com/features/transactions)、[连接池](https://node-postgres.com/features/pooling)、[PostgreSQL 事务锁](https://www.postgresql.org/docs/17/explicit-locking.html)。
