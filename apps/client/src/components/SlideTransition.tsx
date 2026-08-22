import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * SlideTransition — 纯 CSS 页面切换过渡（复刻 Auroraqua 的 framer-motion AnimatePresence mode="wait"）
 * mode 变化时：旧页面向左滑出（x:0 -> -24 + fade），新页面从右侧滑入（x:24 -> 0 + fade），各 300ms。
 * 仅用 CSS animation，兼容安卓 6+ 老 WebView。
 */
export default function SlideTransition({ mode, children }: { mode: string; children: ReactNode }) {
  const [shown, setShown] = useState<{ key: string; node: ReactNode }>({ key: mode, node: children });
  const [exiting, setExiting] = useState<{ key: string; node: ReactNode } | null>(null);
  const prev = useRef<{ mode: string; key: string; node: ReactNode }>({ mode, key: mode, node: children });

  useEffect(() => {
    const before = prev.current;
    const after = { mode, key: mode, node: children };
    prev.current = after;
    if (before.mode === after.mode) {
      setShown(after);
      return;
    }
    setExiting(before);
    setShown(after);
    const timer = window.setTimeout(() => setExiting(null), 320);
    return () => window.clearTimeout(timer);
  }, [mode, children]);

  return (
    <div className="slide-transition" style={{ position: "relative" }}>
      {exiting && (
        <div className="slide-exit" key={`exit-${exiting.key}`} aria-hidden="true">
          {exiting.node}
        </div>
      )}
      <div className="slide-enter" key={`enter-${shown.key}`}>
        {shown.node}
      </div>
    </div>
  );
}