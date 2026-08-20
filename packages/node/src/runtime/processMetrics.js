export function readProcessRssBytes() {
  return process.memoryUsage().rss;
}
