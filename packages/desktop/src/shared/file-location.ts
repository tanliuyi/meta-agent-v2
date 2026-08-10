const FILE_LOCATION_SUFFIX = /^(.*?)(?::\d+(?::\d+)?(?:-\d+)?)$/u;

/** 去除本地文件引用中的行号或行列号后缀。 */
export function filePathWithoutLocation(path: string): string {
  const match = path.match(FILE_LOCATION_SUFFIX);
  return match?.[1] ? match[1] : path;
}
