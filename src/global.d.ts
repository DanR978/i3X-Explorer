interface HttpRequestOptions {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}

interface HttpResponse {
  ok: boolean
  status: number
  statusText: string
  text: string
}

interface SSEOptions {
  url: string
  headers?: Record<string, string>
}

interface Window {
  electronAPI?: {
    platform: string
    versions: {
      node: string
      chrome: string
      electron: string
    }
    httpRequest: (options: HttpRequestOptions) => Promise<HttpResponse>
    sseConnect: (options: SSEOptions) => Promise<{ streamId: string; ok: boolean; error?: string }>
    sseDisconnect: (streamId: string) => Promise<void>
    onSSEData: (streamId: string, callback: (data: string) => void) => () => void
    onSSEError: (streamId: string, callback: (error: string) => void) => () => void
    onSSEEnd: (streamId: string, callback: () => void) => () => void
    encryptString: (plaintext: string) => Promise<string | null>
    decryptString: (encrypted: string) => Promise<string | null>
    openDevTools: () => Promise<void>
  }
}
