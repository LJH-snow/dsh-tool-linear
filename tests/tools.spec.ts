import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { LinearClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function jsonGraphql(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function tools(client = new LinearClient({ fetchImpl: globalThis.fetch })) {
  return Object.fromEntries(createTools(client).map(tool => [tool.name, tool]))
}

const issueNode = {
  id: 'issue-1',
  identifier: 'ABC-1',
  title: 'Fix checkout',
  description: 'Details.',
  priority: 2,
  priorityLabel: 'High',
  url: 'https://linear.app/acme/issue/ABC-1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  dueDate: null,
  team: { id: 'team-1', key: 'ABC', name: 'Acme' },
  state: { id: 'state-1', name: 'In Progress', type: 'started' },
  project: { id: 'project-1', name: 'Checkout' },
  cycle: { id: 'cycle-1', name: 'Cycle 5' },
  assignee: { id: 'user-1', name: 'Alice', displayName: 'Alice' },
  labels: { nodes: [{ id: 'label-1', name: 'bug' }] },
}

describe('tool definitions', () => {
  it('registers the planned Linear tool set', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'linear_add_issue_comment',
      'linear_create_issue',
      'linear_get_cycle',
      'linear_get_issue',
      'linear_get_project',
      'linear_get_team',
      'linear_list_cycles',
      'linear_list_issue_comments',
      'linear_list_issues',
      'linear_list_projects',
      'linear_list_teams',
      'linear_search_issues',
      'linear_update_issue',
    ])
  })

  it('returns business values without an API key', async () => {
    const map = tools()
    expect(await map.linear_search_issues.execute({ query: 'checkout' }, exec())).toMatchObject({
      authenticated: false,
      items: [],
    })
    expect(await map.linear_get_issue.execute({ id: 'ABC-1' }, exec())).toMatchObject({ authenticated: false, found: false })
    expect(await map.linear_create_issue.execute({ teamId: 'team-1', title: 'x' }, exec())).toMatchObject({ created: false })
    expect(await map.linear_update_issue.execute({ id: 'issue-1', title: 'x' }, exec())).toMatchObject({ ok: false })
    expect(await map.linear_add_issue_comment.execute({ id: 'issue-1', body: 'x' }, exec())).toMatchObject({ ok: false })
  })

  it('search_issues executes with an API key and forwards variables', async () => {
    const fetchImpl = vi.fn(async () => jsonGraphql({ data: { searchIssues: { nodes: [issueNode] } } }))
    const client = new LinearClient({ apiKey: 'lin_api_test', fetchImpl })
    const map = tools(client)
    const result = await map.linear_search_issues.execute({ query: 'checkout', teamId: 'team-1', limit: 500 }, exec())
    expect(result).toMatchObject({ authenticated: true, found: true, items: [{ identifier: 'ABC-1' }] })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.variables).toEqual({ term: 'checkout', teamId: 'team-1', first: 100 })
  })

  it('get_issue maps not found to found:false', async () => {
    const client = new LinearClient({ apiKey: 't', fetchImpl: vi.fn(async () => jsonGraphql({ data: { issue: null } })) })
    const map = tools(client)
    expect(await map.linear_get_issue.execute({ id: 'missing-issue' }, exec())).toEqual({ authenticated: true, found: false })
  })

  it('create_issue maps GraphQL validation errors to created:false', async () => {
    const client = new LinearClient({ apiKey: 't', fetchImpl: vi.fn(async () => jsonGraphql({
      errors: [{ message: 'Team not found', extensions: { code: 'BAD_USER_INPUT' } }],
    })) })
    const map = tools(client)
    const result = await map.linear_create_issue.execute({ teamId: 'missing', title: 'x' }, exec())
    expect(result).toMatchObject({ created: false, reason: 'Team not found' })
  })

  it('update_issue requires at least one field', async () => {
    const client = new LinearClient({ apiKey: 't', fetchImpl: vi.fn() })
    const map = tools(client)
    const result = await map.linear_update_issue.execute({ id: 'issue-1' }, exec())
    expect(result).toMatchObject({ ok: false })
    expect(String(result.reason)).toContain('at least one field')
  })

  it('render produces readable issue text from the canonical value', async () => {
    const map = tools()
    const blocks = await (map.linear_search_issues.output as { render: (a: unknown, v: any) => unknown }).render({}, {
      authenticated: true,
      found: true,
      items: [{ identifier: 'ABC-1', title: 'Fix checkout', status: 'In Progress', url: 'https://linear.app/acme/issue/ABC-1' }],
    })
    expect(JSON.stringify(blocks)).toContain('ABC-1: Fix checkout [In Progress]')
  })

  it('presents issue search and create cards', () => {
    const map = tools()
    expect(map.linear_search_issues.presentCall!({ query: 'checkout' })).toMatchObject({ card: 'generic', kind: 'search' })
    expect(map.linear_get_issue.presentCall!({ id: 'ABC-1' })).toMatchObject({ card: 'generic', kind: 'read' })
    expect(map.linear_get_issue.presentResult!({ id: 'ABC-1' }, { authenticated: true, found: false })).toMatchObject({ title: 'Issue not found' })
    expect(map.linear_create_issue.presentCall!({ teamId: 'team-1', title: 'x' })).toMatchObject({ card: 'generic', kind: 'edit' })
    expect(map.linear_create_issue.presentResult!({ teamId: 'team-1', title: 'x' }, { created: true, identifier: 'ABC-2' })).toMatchObject({ title: 'Linear issue ABC-2 created' })
  })
})
