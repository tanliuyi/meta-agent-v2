const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function userAvatarInitial(userName: string): string {
  const [firstGrapheme] = graphemeSegmenter.segment(userName.trim());
  return firstGrapheme?.segment.toLocaleUpperCase() ?? "用";
}
