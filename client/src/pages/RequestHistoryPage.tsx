import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Trash2, Eye, Clock, CheckCircle, XCircle, Filter, X } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { RequestLog } from '@freellmapi/shared/types'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'

interface RequestHistoryResponse {
  requests: RequestLog[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

interface RequestHistoryStats {
  totalRequests: number
  providerStats: { provider: string; count: number }[]
  statusStats: { status: string; count: number }[]
  recentActivity: {
    last24Hours: number
  }
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncateText(text: string | null, maxLength: number = 100): string {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function RequestDetailsModal({ request, onClose }: { request: RequestLog; onClose: () => void }) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<'request' | 'response'>('request')
  
  // Fetch full detail (with request/response bodies) on demand
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['requestHistoryDetail', request.id],
    queryFn: () => apiFetch<RequestLog>(`/api/request-history/${request.id}`),
  })
  
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  
  const formatJson = (jsonString: string | null) => {
    if (!jsonString) return t('requestHistory.noData')
    try {
      const parsed = JSON.parse(jsonString)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return jsonString
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-3xl border bg-card p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t('requestHistory.requestDetails')} #{request.id}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="font-medium">{t('requestHistory.provider')}:</span> {request.platform}
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.provider')}:</span> {request.provider}
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.model')}:</span> {request.modelId}
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.status')}:</span> 
              <Badge variant={request.status === 'success' ? 'default' : 'destructive'}>
                {request.status === 'success' ? (
                  <CheckCircle className="h-3 w-3 mr-1" />
                ) : (
                  <XCircle className="h-3 w-3 mr-1" />
                )}
                {request.status === 'success' ? t('requestHistory.success') : t('requestHistory.error')}
              </Badge>
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.inputTokens')}:</span> {request.inputTokens}
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.outputTokens')}:</span> {request.outputTokens}
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.latency')}:</span> {formatLatency(request.latencyMs)}
            </div>
            <div>
              <span className="font-medium">{t('requestHistory.time')}:</span> {formatSqliteUtcToLocalTime(request.createdAt)}
            </div>
          </div>
          
          {request.error && (
            <div className="text-sm">
              <span className="font-medium text-destructive">{t('requestHistory.errorLabel')}:</span> 
              <p className="mt-1 p-2 bg-destructive/10 rounded text-destructive">
                {request.error}
              </p>
            </div>
          )}
          
          <div className="border rounded">
            <div className="flex border-b">
              <Button
                variant={activeTab === 'request' ? 'default' : 'ghost'}
                className="flex-1 rounded-none"
                onClick={() => setActiveTab('request')}
              >
                {t('requestHistory.requestBody')}
              </Button>
              <Button
                variant={activeTab === 'response' ? 'default' : 'ghost'}
                className="flex-1 rounded-none"
                onClick={() => setActiveTab('response')}
              >
                {t('requestHistory.responseBody')}
              </Button>
            </div>
            
            <div className="h-[400px] overflow-y-auto p-4">
              {detailLoading ? (
                <div className="text-center py-8 text-muted-foreground">{t('requestHistory.loading')}</div>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap">
                  {activeTab === 'request' 
                    ? formatJson(detail?.requestBody ?? null)
                    : formatJson(detail?.responseBody ?? null)
                  }
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function RequestHistoryPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [limit] = useState(50)
  const [provider, setProvider] = useState<string>('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState<string>('')
  const [search, setSearch] = useState('')
  const [selectedRequest, setSelectedRequest] = useState<RequestLog | null>(null)
  
  // Fetch request history
  const { data, isLoading, error } = useQuery({
    queryKey: ['requestHistory', page, limit, provider, model, status, search],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      })
      if (provider && provider !== 'all') params.append('provider', provider)
      if (model) params.append('model', model)
      if (status && status !== 'all') params.append('status', status)
      if (search) params.append('search', search)
      
      return await apiFetch<RequestHistoryResponse>(`/api/request-history?${params.toString()}`)
    },
  })
  
  // Fetch stats
  const { data: stats } = useQuery({
    queryKey: ['requestHistoryStats'],
    queryFn: async () => {
      return await apiFetch<RequestHistoryStats>('/api/request-history/stats')
    },
  })
  
  // Clear all history mutation
  const clearHistory = useMutation({
    mutationFn: () => apiFetch('/api/request-history', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requestHistory'] })
      queryClient.invalidateQueries({ queryKey: ['requestHistoryStats'] })
      setPage(1)
    },
  })
  
  const providerOptions = stats?.providerStats.map(p => p.provider) || []
  
  const statsCards = [
    {
      title: t('requestHistory.totalRequests'),
      value: stats?.totalRequests || 0,
      description: t('requestHistory.lastRecords'),
    },
    {
      title: t('requestHistory.last24Hours'),
      value: stats?.recentActivity.last24Hours || 0,
      description: t('requestHistory.recentActivity'),
    },
    {
      title: t('requestHistory.successRate'),
      value: stats ? 
        `${(((stats.statusStats.find(s => s.status === 'success')?.count || 0) / stats.totalRequests) * 100).toFixed(1)}%`
        : '0%',
      description: t('requestHistory.overallSuccessRate'),
    },
  ]

  return (
    <div className="container py-6 space-y-6">
      <PageHeader
        title={t('requestHistory.title')}
        description={t('requestHistory.description')}
        actions={
          <Button 
            variant="destructive" 
            onClick={() => clearHistory.mutate()}
            disabled={clearHistory.isPending}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {t('requestHistory.clearHistory')}
          </Button>
        }
      />
      
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {statsCards.map((card, index) => (
          <Card key={index}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
              <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      
      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center">
            <Filter className="h-5 w-5 mr-2" />
            {t('requestHistory.filters')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">{t('requestHistory.provider')}</label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger>
                  <SelectValue placeholder={t('requestHistory.allProviders')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('requestHistory.allProviders')}</SelectItem>
                  {providerOptions.map(p => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">{t('requestHistory.model')}</label>
              <Input 
                placeholder={t('requestHistory.modelPlaceholder')} 
                value={model} 
                onChange={e => setModel(e.target.value)} 
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">{t('requestHistory.status')}</label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue placeholder={t('requestHistory.allStatuses')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('requestHistory.allStatuses')}</SelectItem>
                  <SelectItem value="success">{t('requestHistory.success')}</SelectItem>
                  <SelectItem value="error">{t('requestHistory.error')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">{t('requestHistory.search')}</label>
              <Input 
                placeholder={t('requestHistory.searchPlaceholder')} 
                value={search} 
                onChange={e => setSearch(e.target.value)} 
              />
            </div>
          </div>
        </CardContent>
      </Card>
      
      {/* Request List */}
      <Card>
        <CardHeader>
          <CardTitle>{t('requestHistory.requests')}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="text-center py-8">{t('requestHistory.loading')}</div>
          )}
          
          {error && (
            <div className="text-center py-8 text-destructive">
              {t('requestHistory.errorLoading')}
            </div>
          )}
          
          {data && (
            <>
              <div className="space-y-4">
                {data.requests.map((request) => (
                  <Card key={request.id} className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline">{request.platform}</Badge>
                          <Badge variant="secondary">{request.provider}</Badge>
                          <span className="text-sm font-medium">{request.modelId}</span>
                          <Badge variant={request.status === 'success' ? 'default' : 'destructive'}>
                            {request.status === 'success' ? (
                              <CheckCircle className="h-3 w-3 mr-1" />
                            ) : (
                              <XCircle className="h-3 w-3 mr-1" />
                            )}
                            {request.status === 'success' ? t('requestHistory.success') : t('requestHistory.error')}
                          </Badge>
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary" className="font-mono text-xs">
                            <Clock className="h-3 w-3 mr-1" />
                            {formatLatency(request.latencyMs)}
                          </Badge>
                          <Badge variant="outline" className="font-mono text-xs">
                            <span className="text-muted-foreground mr-1">In:</span>
                            {request.inputTokens}
                          </Badge>
                          <Badge variant="outline" className="font-mono text-xs">
                            <span className="text-muted-foreground mr-1">Out:</span>
                            {request.outputTokens}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatSqliteUtcToLocalTime(request.createdAt)}
                          </span>
                        </div>
                        
                        {request.error && (
                          <div className="text-sm text-destructive">
                            <span className="font-medium">{t('requestHistory.errorLabel')}:</span> {truncateText(request.error)}
                          </div>
                        )}
                      </div>
                      
                      <div className="ml-4 flex-shrink-0">
                        <Button variant="outline" size="sm" onClick={() => setSelectedRequest(request)}>
                          <Eye className="h-4 w-4 mr-1" />
                          {t('requestHistory.details')}
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
              
              {/* Pagination */}
              <div className="flex items-center justify-between mt-6">
                <div className="text-sm text-muted-foreground">
                  {t('requestHistory.showing', { 
                    from: ((page - 1) * limit) + 1, 
                    to: Math.min(page * limit, data.pagination.total), 
                    total: data.pagination.total 
                  })}
                </div>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm"
                    disabled={page === 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                  >
                    {t('requestHistory.previous')}
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm"
                    disabled={page >= data.pagination.totalPages}
                    onClick={() => setPage(p => p + 1)}
                  >
                    {t('requestHistory.next')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {selectedRequest && (
        <RequestDetailsModal request={selectedRequest} onClose={() => setSelectedRequest(null)} />
      )}
    </div>
  )
}
