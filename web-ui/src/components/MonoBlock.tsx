import type { ReactNode } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

export const monoFontFamily = "Consolas, 'Cascadia Mono', monospace";

const useStyles = makeStyles({
  block: {
    fontFamily: monoFontFamily,
    fontSize: '12px',
    backgroundColor: '#161616',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '10px 12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    lineHeight: 1.6,
  },
  inline: {
    fontFamily: monoFontFamily,
  },
});

export function MonoBlock({
  children,
  className,
  color,
}: {
  children: ReactNode;
  className?: string;
  color?: string;
}) {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.block, className)} style={color ? { color } : undefined}>
      {children}
    </div>
  );
}

export function Mono({ children, color }: { children: ReactNode; color?: string }) {
  const styles = useStyles();
  return (
    <span className={styles.inline} style={color ? { color } : undefined}>
      {children}
    </span>
  );
}
