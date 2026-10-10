import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';

interface CopyButtonProps {
  /** Text written to the clipboard. */
  text: string;
  /** Accessible label + tooltip. Defaults to "Copy". */
  label?: string;
  /** Icon size in px. */
  size?: number;
  className?: string;
}

/**
 * Icon button that copies `text` to the clipboard (Clipboard API, then the
 * execCommand fallback for plain-http origins) and reports the outcome with a
 * translated toast. Never throws.
 */
export function CopyButton({ text, label, size = 14, className }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    // Copy buttons often sit inside clickable rows / forms.
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(text);
    if (!ok) {
      toast.error(t('common.copyFailed', 'Could not copy. Select the text and copy it manually.'));
      return;
    }
    toast.success(t('common.copied', 'Copied!'));
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const accessibleLabel = label ?? t('common.copy', 'Copy');

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors',
        className,
      )}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {copied ? <Check size={size} className="text-status-up" /> : <Copy size={size} />}
    </button>
  );
}
