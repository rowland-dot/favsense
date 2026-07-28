# 资源索引领域接口

资源索引是 FavSense · 拾光台的通用资料浏览器。采集层仍只负责同步小红书收藏；领域配置决定页面如何归类开源项目、官方网站、文档、教程、训练资料、护肤成分或其他对象。

## 内置模板

| 领域配置 | 页面名称 | 实体字段 | 指标 | 权威入口 |
| --- | --- | --- | --- | --- |
| `software.json` | 资源索引 | 开源项目、网站、文档、教程 | 项目可显示 GitHub Star | 仓库、官网、文档、教程 |
| `fitness.json` | 训练资料库 | 目标、适用人群、注意事项 | 资料完整度 | 政府或专业组织指南 |
| `skincare.json` | 成分资料库 | 适用场景、耐受提示、使用边界 | 资料完整度 | 皮肤科或政府健康来源 |

这些示例只演示数据接口，不构成医疗诊断、治疗或个体化训练建议。

## 配置结构

`domain_profile.resource_index` 定义：

- `label`、`entity_label` 与页面叙事；
- `registry_file`、`collection` 和 `mapping`，把领域注册表转换为统一公开结构；
- `fields`，声明卡片需要显示的领域专属字段；
- `groups`，用正则规则生成一个可筛选的领域分组；
- `sorts`，声明名称或指标的排序选项；可用 `applies_to` 把专属排序绑定到一个或多个资源类型；
- `actions`，声明官方来源、下载或指南入口；
- `metric`，声明指标名称、图标与缺失值文案。

浏览器组件只读取生成后的统一结构：

```json
{
  "name": "资源名称",
  "aliases": [],
  "type": "领域类型",
  "description": "用途、适用条件或使用提示",
  "metric": "可读指标",
  "metricNumeric": 3,
  "attributes": [{ "label": "适用", "value": "领域值" }],
  "actions": [{ "label": "权威依据", "url": "https://example.org" }]
}
```

因此，前端没有 GitHub、Star、目标肌群或肤质等硬编码。一个资源只需提供适合自己的入口；例如教程不必伪造下载链接，开源项目也不必附带无关的文档字段。新增领域时复制一个 profile 和一个资源注册表即可；小红书登录、增量同步、去重与隐私规则不需要修改。

## 类型与排序关联

排序不是一组对所有资源无条件展示的按钮。每个排序项都应回答“这个字段对哪些资源类型有意义”：

- 不写 `applies_to`：通用排序，在“全部类型”和每个具体类型中都可用，例如按名称排序；
- 写入 `applies_to`：专属排序，只在选中的资源分组匹配时出现；
- 用户切换资源类型后，前端会立即重建二级排序菜单；若原排序不再适用，则自动切换到该类型的第一个有效排序；
- 每个领域至少保留一个通用排序，避免某个类型没有可用选项。

software 模板把 Star 排序限定为开源项目：

```json
{
  "sorts": [
    { "id": "name-asc", "label": "名称 A–Z", "field": "name", "type": "text", "direction": "asc" },
    { "id": "metric-desc", "label": "Star 从高到低", "field": "metricNumeric", "type": "number", "direction": "desc", "applies_to": ["开源项目"] }
  ]
}
```

因此，“全部类型”“官方网站”“官方文档”和“教程”不会出现 Star 排序。其他领域也应遵循同一原则：训练资料完整度只关联拥有该指标的训练资源，价格、浓度或证据等级也只能出现在实际提供这些字段的类型中。

## Agent 自动搭建规则

让 Agent 为新领域搭建资源索引时，应依次完成：

1. 读取资源注册表，列出真实存在的实体类型和字段，不从页面文案臆造字段；
2. 用 `groups` 定义用户能理解的一级资源类型；
3. 区分通用字段与类型专属字段，名称通常通用，Star、价格、浓度等通常专属；
4. 为专属排序填写 `applies_to`，其值必须精确匹配 `groups[].label` 或 `default_group`；
5. 至少保留一个无 `applies_to` 的通用排序；
6. 只为资源真实拥有的 URL 配置 `actions`，构建后运行测试验证所有关联。

Agent 不应把 software 模板中的 GitHub/Star 逻辑复制到其他领域；它应从当前注册表的数据能力反推筛选、排序和入口。公开站点构建器会校验当前 profile：`applies_to` 引用未知类型、使用非数组值或完全没有通用排序时会直接停止构建。

## 切换模板

在本机私有 `config/xhs-favorites.json` 中设置：

```json
{
  "domain_profile": "config/domain-profiles/fitness.json"
}
```

然后重新运行每日同步或：

```powershell
node ".\skills\xhs-favorites-organizer\scripts\build-public-site.mjs"
```

公开演示默认使用 software。fitness 与 skincare 注册表位于 `config/resource-registries/`，可以直接用于接口验证，也可以替换为自己的公开、可核验资料。
