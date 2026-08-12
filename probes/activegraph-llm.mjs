import { createServer } from "node:http"

export const startFakeLlm = async (port) => {
  let lastRequest
  const server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8").on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      lastRequest = JSON.parse(raw)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "I know agentlab only; notes is outside my scope." } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 71, completion_tokens: 12 } })}\n\n` +
          "data: [DONE]\n\n",
      )
    })
  })
  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject))
  return {
    request: () => lastRequest,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
