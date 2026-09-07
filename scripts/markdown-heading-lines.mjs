export function markdownHeadingLines(lines) {
  const headings = [];
  let fence;
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/u);
    if (heading) headings.push({ index, level: heading[1].length, title: heading[2] });
  }
  return headings;
}
