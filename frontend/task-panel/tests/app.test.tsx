import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app/App'
import { DemoController } from '../src/demo/demo-controller'
import { SCENARIOS } from '../src/data/mock/scenarios'

function setup(initialScenarioId = 'M06') {
  const controller = new DemoController(SCENARIOS, initialScenarioId)
  render(<App controller={controller} />)
  return { controller, user: userEvent.setup() }
}

describe('面板主流程', () => {
  it('持续显示"模拟数据"标记与合成数据说明', async () => {
    setup()
    expect(await screen.findByText('模拟数据')).toBeInTheDocument()
    expect(screen.getByText(/不连接真实 WorkBuddy/)).toBeInTheDocument()
  })

  it('已取消任务不提供恢复、重试或验收入口', async () => {
    setup('M06')
    const next = await screen.findByTestId('status-next')
    expect(next).toHaveTextContent('重新建立任务')
    expect(screen.getByTestId('detail-title')).toHaveTextContent('删除废弃脚本')

    const detail = screen.getByRole('region', { name: '任务详情' })
    for (const label of ['验收', '取消任务', '继续', '重试', '恢复', '重新派工']) {
      expect(within(detail).queryByRole('button', { name: label })).toBeNull()
    }

    expect(screen.getByTestId('remaining')).toHaveTextContent('期限已结束')
    expect(screen.queryByText(/观测信息较旧/)).toBeNull()
  })

  it('报告先到时等待停止，不提前显示已验收', async () => {
    const { user } = setup('M02')
    await screen.findByTestId('detail-title')
    expect(screen.queryByText('已独立验收')).toBeNull()

    await user.click(screen.getByRole('button', { name: '下一帧' }))
    const report = await screen.findByTestId('report-status')
    expect(report).toHaveTextContent('仍在等待原生停止确认')
    expect(screen.queryByText('已独立验收')).toBeNull()

    await user.click(screen.getByRole('button', { name: '下一帧' }))
    expect(await screen.findByTestId('report-status')).toHaveTextContent('已收到执行报告，尚未独立验收')
  })

  it('未知成本与字节显示"未知"，不显示 0', async () => {
    const { user } = setup('M12')
    await screen.findByTestId('detail-title')
    await user.click(screen.getByRole('tab', { name: '报告与检查' }))

    const creditsLabel = await screen.findByText('实际积分')
    expect(creditsLabel.nextElementSibling).toHaveTextContent('未知')
    expect(screen.getByText('检查器错误')).toBeInTheDocument()
    expect(screen.queryByText('0 秒')).toBeNull()
  })

  it('断线保留旧快照并提示，不自动推进状态', async () => {
    const { user } = setup('M10')
    await screen.findByTestId('detail-title')
    await user.click(screen.getByRole('button', { name: '下一帧' }))
    expect((await screen.findAllByText(/仅显示旧快照/)).length).toBeGreaterThan(0)
    expect(screen.getByTestId('connection-status')).toHaveTextContent('连接中断')
  })

  it('筛选无结果与空列表区分，并可清除筛选', async () => {
    const { user } = setup('M14')
    expect(await screen.findByTestId('empty-list')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '下一帧' }))
    await user.click(screen.getByRole('button', { name: '下一帧' }))
    await screen.findByTestId('detail-title')

    await user.type(screen.getByLabelText('搜索任务标题'), '不存在的标题')
    const noMatch = await screen.findByTestId('no-match')
    expect(noMatch).toHaveTextContent('没有匹配的任务')

    await user.click(within(noMatch).getByRole('button', { name: '清除筛选' }))
    expect(await screen.findByTestId('detail-title')).toBeInTheDocument()
  })

  it('第 3 / 3 轮保留历史，没有第四轮入口', async () => {
    setup('M11')
    expect(await screen.findByText(/第 3 \/ 3 轮/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /第四轮|再来一轮|继续执行/ })).toBeNull()
  })

  it('原生等待详情未知时明确说明不可用，不编造请求', async () => {
    setup('M04')
    await screen.findByTestId('detail-title')
    expect(screen.getByTestId('blocker-unknown')).toHaveTextContent('具体请求详情不可用')
    expect(screen.queryByText('write_file')).toBeNull()
  })

  it('取消请求已记录但未停止时，不显示为已取消', async () => {
    setup('M05')
    await screen.findByTestId('detail-title')
    const detail = screen.getByRole('region', { name: '任务详情' })
    expect(within(detail).getByText('等待停止确认')).toBeInTheDocument()
    expect(within(detail).queryByText('已取消')).toBeNull()
  })

  it('到期任务保留期限、迟到报告可查阅但不显示按期成功', async () => {
    setup('M07')
    await screen.findByTestId('detail-title')
    const detail = screen.getByRole('region', { name: '任务详情' })
    expect(within(detail).getByText('已超过期限')).toBeInTheDocument()
    expect(screen.getByText(/报告在期限之后才送达/)).toBeInTheDocument()
    expect(screen.queryByText('已独立验收')).toBeNull()
  })

  it('越界文件单独标为未授权，不合并成通过', async () => {
    const { user } = setup('M13')
    await screen.findByTestId('detail-title')
    await user.click(screen.getByRole('tab', { name: '文件变化' }))
    expect(await screen.findByText('src/unrelated/extra.ts')).toBeInTheDocument()
    expect(screen.getByText('未授权')).toBeInTheDocument()
    expect(screen.getByText(/存在未授权文件变化/)).toBeInTheDocument()
  })

  it('恶意文本只作为文字渲染，不产生脚本节点', async () => {
    const { user } = setup('M16')
    await screen.findByTestId('detail-title')
    await user.click(screen.getByRole('tab', { name: '报告与检查' }))
    expect(await screen.findByText(/不要执行这段文本/)).toBeInTheDocument()
    expect(document.querySelectorAll('script')).toHaveLength(0)
  })

  it('标签页支持方向键切换', async () => {
    const { user } = setup('M01')
    await screen.findByTestId('detail-title')
    const overview = screen.getByRole('tab', { name: '概况' })
    overview.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: '报告与检查' })).toHaveAttribute('aria-selected', 'true')
  })

  it('未知枚举按"未知状态"展示，不映射为已验收', async () => {
    const { user } = setup('M15')
    await screen.findByTestId('detail-title')
    await user.click(screen.getByRole('button', { name: /未知状态与新枚举/ }))
    expect(await screen.findByText(/未识别的展示状态/)).toBeInTheDocument()
    expect(screen.getByText('verification_pending')).toBeInTheDocument()
    const detail = screen.getByRole('region', { name: '任务详情' })
    expect(within(detail).getByText('未知状态，需核查')).toBeInTheDocument()
  })
})
