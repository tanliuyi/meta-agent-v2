import { useEffect, useState } from "react";

/** 为本地 File 创建可释放的 object URL，并在文件切换或卸载时回收。 */
export function useFileSrc(file: File | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return src;
}
