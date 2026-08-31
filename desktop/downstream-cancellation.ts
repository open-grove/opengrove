// Electron 的 protocol.handle 会给 handler 一个 request.signal，但 renderer 放弃请求时它并不触发
// （Electron 42 实测：signal 在，abort 事件永不到达）。真正会传到主进程的信号是 Chromium 停止读取
// 响应体，也就是我们交回去的那条 ReadableStream 的 cancel()。
//
// 不把这个信号接到 net.fetch 上，被放弃的请求会一直占着主进程到 Bridge 的连接：Chromium 对
// HTTP/1.1 的单源连接上限是 6，占满之后同源的新请求全部堵在连接池里发不出去，界面上就是面板一直
// 转圈到超时、只能重启客户端。

// 这些状态码不允许带 body：即便上游给回一条空流，也不能拿它去构造新 Response，否则直接抛错。
const NULL_BODY_STATUS_CODES = new Set([101, 103, 204, 205, 304]);

export interface DownstreamCancellation {
  /** 交给 net.fetch 的信号：下游一放弃就 abort。 */
  readonly signal: AbortSignal;
  /** 把上游响应换成"下游一取消就中止上游"的响应。 */
  cancelable(upstream: Response): Response;
}

export function createDownstreamCancellation(downstreamSignal: AbortSignal): DownstreamCancellation {
  const cancellation = new AbortController();
  const abandon = (reason: unknown) => cancellation.abort(reason);
  if (downstreamSignal.aborted) abandon(downstreamSignal.reason);
  else downstreamSignal.addEventListener("abort", () => abandon(downstreamSignal.reason), { once: true });

  return {
    signal: cancellation.signal,
    cancelable(upstream) {
      if (!upstream.body || NULL_BODY_STATUS_CODES.has(upstream.status)) return upstream;
      const reader = upstream.body.getReader();
      return new Response(
        new ReadableStream({
          // 按需拉取，别一次抽干：背压要一路留给上游，否则大文件会整段堆进主进程内存。
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel() {
            abandon(new Error("downstream stopped reading the response body"));
          },
        }),
        {
          headers: upstream.headers,
          status: upstream.status,
          statusText: upstream.statusText,
        },
      );
    },
  };
}
