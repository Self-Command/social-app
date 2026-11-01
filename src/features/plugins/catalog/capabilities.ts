export const CAPABILITY_CATALOG = [
  [
    'feed.read',
    '读取信息流',
    '读取当前可见的信息流条目。',
    false,
    '每页 20 条；只读；不含私信。',
    '返回无权限，插件降级。',
  ],
  [
    'profile.read',
    '读取公开资料',
    '读取公开资料字段。',
    false,
    '每次 1 个；字段白名单。',
    '返回空，插件降级。',
  ],
  [
    'search.read',
    '搜索公开内容',
    '搜索公开帖子与用户。',
    false,
    '每页 25 条；查询不超过 256 字符。',
    '返回错误，保留宿主搜索。',
  ],
  [
    'notifications.read',
    '读取通知',
    '读取通知元数据。',
    false,
    '每页 20 条；不含邮箱与私信正文。',
    '返回无权限。',
  ],
  [
    'notifications.markRead',
    '标记通知已读',
    '将当前账号的通知标记为已读。',
    false,
    '单次不超过 50 条；仅当前账号。',
    '拒绝，不修改状态。',
  ],
  [
    'messages.metadata',
    '读取会话元数据',
    '读取会话列表与未读数。',
    false,
    '每页 20 条；不含正文与参与者身份。',
    '返回脱敏空值。',
  ],
  [
    'lists.read',
    '读取列表',
    '读取列表、成员与订阅源。',
    false,
    '每页 50 条；仅公开列表。',
    '返回无权限。',
  ],
  [
    'preferences.read',
    '读取外观偏好',
    '读取主题、语言与减少动态效果设置。',
    false,
    '只读。',
    '返回默认值。',
  ],
  [
    'composer.insertText',
    '插入文本',
    '向发帖或回复输入框插入文本。',
    false,
    '不超过 10 KB；宿主去除控制字符。',
    '拒绝，保留原文。',
  ],
  [
    'composer.attach',
    '附加媒体',
    '打开宿主媒体选择器并附加媒体。',
    false,
    '图片 4 张或视频 1 个；宿主校验。',
    '拒绝，不打开选择器。',
  ],
  [
    'composer.open',
    '打开发帖器',
    '打开发帖器或回复器。',
    false,
    '文本不超过 10 KB；参数不超过 1 KB。',
    '拒绝。',
  ],
  [
    'post.reply',
    '创建回复',
    '以当前账号创建回复。',
    false,
    '300 字素；可携带 1 个已声明的自定义嵌入，且不超过 16 KB。',
    '拒绝并显示中文错误。',
  ],
  [
    'post.quote',
    '引用发帖',
    '以当前账号创建引用帖。',
    false,
    '300 字素；可携带 1 个已声明的自定义嵌入，且不超过 16 KB。',
    '拒绝并显示中文错误。',
  ],
  [
    'post.delete',
    '删除帖子',
    '删除当前账号的帖子。',
    false,
    '仅本人；宿主提供二次确认。',
    '拒绝。',
  ],
  [
    'record.create',
    '创建记录',
    '在本人仓库创建已声明的记录。',
    false,
    '记录不超过 10 KB；集合白名单。',
    '拒绝。',
  ],
  [
    'record.delete',
    '删除记录',
    '删除本人仓库中已声明的记录。',
    false,
    '仅本人；集合白名单。',
    '拒绝。',
  ],
  [
    'media.pick',
    '选择媒体',
    '选择图片、视频或音频。',
    false,
    '系统权限；宿主校验 MIME 类型。',
    '拒绝，保留入口。',
  ],
  [
    'media.upload',
    '上传媒体',
    '上传媒体到当前账号。',
    false,
    '图片 5 MB、视频 50 MB、音频 5 MB。',
    '拒绝并显示限额。',
  ],
  [
    'media.playback',
    '播放媒体',
    '使用宿主播放器播放音视频。',
    false,
    '单实例；进入后台时停止。',
    '提示不可播放。',
  ],
  [
    'storage.local',
    '本地键值存储',
    '在当前账号与本插件范围内保存 JSON 数据。',
    false,
    '256 KB；200 个键；仅 JSON。',
    '返回配额错误。',
  ],
  [
    'toast.show',
    '显示提示',
    '显示短暂状态提示。',
    false,
    '200 字符；每 2 秒 1 次。',
    '静默忽略。',
  ],
  [
    'navigation.open',
    '打开页面',
    '打开宿主路由或本插件页面。',
    false,
    '路由白名单；参数不超过 1 KB。',
    '拒绝。',
  ],
  [
    'navigation.contribute',
    '贡献导航入口',
    '声明导航入口。',
    false,
    '每个插件不超过 6 个；由宿主渲染。',
    '忽略超额项。',
  ],
  [
    'overlay.show',
    '显示浮层',
    '显示宿主模态或底部面板。',
    false,
    '同时 1 个；可关闭。',
    '拒绝。',
  ],
  [
    'network.request',
    '发起网络请求',
    '经宿主代理请求外部 HTTPS 地址。',
    false,
    '允许域名；5 秒超时；响应不超过 256 KB。',
    '拒绝并记录安全事件。',
  ],
  [
    'share.open',
    '打开系统分享',
    '打开系统分享面板。',
    false,
    '文本不超过 4 KB 或仅链接。',
    '忽略。',
  ],
  [
    'clipboard.write',
    '写入剪贴板',
    '写入剪贴板。',
    false,
    '不超过 4 KB；需用户手势。',
    '拒绝。',
  ],
  [
    'ui.decorate',
    '包裹宿主组件',
    '使用包装器包裹宿主组件。',
    false,
    '仅声明位置；必须原样渲染 children。',
    '回退原始组件。',
  ],
  [
    'media.record',
    '录制音频',
    '使用宿主录音组件采集麦克风音频。',
    false,
    '需系统麦克风权限；前台；1 至 60 秒；单实例。',
    '拒绝并显示权限或设备说明。',
  ],
  [
    'native.host',
    '原生宿主信息',
    '读取原生宿主信息与写入脱敏日志。',
    true,
    '只返回 nativeApi、应用版本、构建号、渠道与平台；不含 DID、令牌与设备标识。',
    '原生插件不渲染。',
  ],
  [
    'native.permissions',
    '原生权限',
    '查询、请求原生权限并打开系统设置。',
    true,
    '只允许清单声明且宿主支持的 5 种权限；仅用户手势触发。',
    '原生插件不渲染或降级。',
  ],
  [
    'native.ui',
    '原生界面',
    '呈现与关闭当前插件的原生视图。',
    true,
    '只能操作本人视图；同时 1 个；宿主拥有标题、关闭与安全区。',
    '拒绝，保持当前界面。',
  ],
  [
    'events.subscribe',
    '订阅宿主事件',
    '订阅白名单宿主事件。',
    true,
    '8 类事件；处理器同步执行且不得抛错；取消函数必须释放。',
    '原生插件不渲染。',
  ],
] as const

export type PluginCapability = (typeof CAPABILITY_CATALOG)[number][0]

export type PluginCapabilityDefinition = {
  readonly id: PluginCapability
  readonly title: string
  readonly description: string
  readonly nativeOnly: boolean
  readonly limits: string
  readonly failureBehavior: string
}

export const CAPABILITY_DEFINITIONS: readonly PluginCapabilityDefinition[] =
  CAPABILITY_CATALOG.map(
    ([id, title, description, nativeOnly, limits, failureBehavior]) => ({
      id,
      title,
      description,
      nativeOnly,
      limits,
      failureBehavior,
    }),
  )

export const PLUGIN_CAPABILITY_IDS: readonly PluginCapability[] =
  CAPABILITY_CATALOG.map(entry => entry[0])

export const NATIVE_CAPABILITY_IDS = [
  'native.host',
  'native.permissions',
  'native.ui',
  'events.subscribe',
] as const

export type NativeCapability = (typeof NATIVE_CAPABILITY_IDS)[number]

export function isNativeCapability(value: string): value is NativeCapability {
  return (NATIVE_CAPABILITY_IDS as readonly string[]).includes(value)
}

export function isPluginCapability(value: unknown): value is PluginCapability {
  return (
    typeof value === 'string' &&
    (PLUGIN_CAPABILITY_IDS as readonly string[]).includes(value)
  )
}
