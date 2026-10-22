import { useCallback, useState } from "react";

import { pickAndImportZip } from "@/lib/import-zip";

/**
 * 选 zip 并导入（按钮用）
 *
 * 侧栏、图库空状态、我的主题空状态都要能导入，按钮态（picking）在这里管；
 * 真正的对话框与导入流程在 `lib/import-zip.ts`，与 Ctrl+O 快捷键共用。
 */
export function useImportTheme() {
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async () => {
    setPicking(true);
    try {
      await pickAndImportZip();
    } finally {
      setPicking(false);
    }
  }, []);

  return { picking, pick };
}
