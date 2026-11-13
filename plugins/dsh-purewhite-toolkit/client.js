/**
 * dsh-purewhite-toolkit 的 Web 客户端模块。
 *
 * 在会话头部「只读模式」标签旁边渲染一个「已切换」徽标：
 *   - 依据 Host 侧 readonly-guard 注册的 `readonlyGuard` 投影（{ released }）；
 *   - 只在「Agent 预设是 readonly」且「已解除只读」时显示；
 *   - 样式只用宿主主题 token，不引入外部依赖。
 *
 * 浏览器侧模块格式：window.__ModuleLoader__.load({ id, factory })，React 由页面模块表提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-purewhite-toolkit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'readonly-badge'
    const zh = {
      badge: '已切换',
      hint: '本会话已从只读模式切换到标准模式，可以写文件。',
    }
    const en = {
      badge: 'Switched',
      hint: 'This session switched from read-only to standard mode and can write files.',
    }

    /**
     * 会话头部徽标：只读预设 + 投影 released 为 true 时显示。
     * @param props 插槽标准属性（useProjection、t）。
     * @returns 徽标节点或 null。
     */
    function ReadonlySwitchedBadge({ useProjection, t }) {
      const preset = useProjection('agentPreset')
      const guard = useProjection('readonlyGuard')
      if (preset !== 'readonly') return null
      if (guard === undefined || guard === null || guard.released !== true) return null
      return h(
        'span',
        {
          title: t('hint'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: 18,
            padding: '0 6px',
            borderRadius: 9,
            fontSize: 11,
            lineHeight: '18px',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'var(--dsw-alias-bg-module-platform)',
          },
        },
        t('badge'),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-purewhite-toolkit: readonly badge locale',
        )
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'readonly-switched',
              order: -9,
              locale: NS,
            },
            ReadonlySwitchedBadge,
          ),
        )
      },
    }
  },
})
