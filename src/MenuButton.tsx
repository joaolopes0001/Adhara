import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type MenuAction = {
  label: string;
  icon?: LucideIcon;
  tone?: 'problem' | 'warning';
  shortcut?: string;
  /** Still reached by the arrows, with the reason in `title`. */
  disabled?: boolean;
  /** A fact to read, not an action: reached by the arrows. */
  info?: boolean;
  title?: string;
  /** The language of the label when it is not the interface's. */
  lang?: string;
  onSelect: () => void;
};
/**
 * Menu button of the bars. Arrows, Home and End move between the actions; Esc (focus returns to the
 * button), Tab or a click outside closes it. The list is fixed to the window so no bar clips it.
 */
export function MenuButton({
  id,
  label,
  title,
  icon: Icon,
  arrow = false,
  active = false,
  hideLabel = false,
  align = 'right',
  above = false,
  className = '',
  actions,
}: {
  id: string;
  label: string;
  title: string;
  icon: LucideIcon;
  arrow?: boolean;
  active?: boolean;
  /** The name only for screen readers. */
  hideLabel?: boolean;
  align?: 'left' | 'right';
  above?: boolean;
  className?: string;
  actions: MenuAction[];
}) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = place !== null;
  const close = (focus: boolean) => {
    setPlace(null);
    if (focus) button.current?.focus();
  };
  const openMenu = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect)
      setPlace({
        position: 'fixed',
        ...(align === 'right'
          ? { right: Math.max(4, innerWidth - rect.right) }
          : { left: Math.max(4, Math.min(rect.left, innerWidth - 244)) }),
        ...(above
          ? { bottom: innerHeight - rect.top + 4, maxHeight: `${Math.round(rect.top) - 12}px` }
          : {
              top: rect.bottom + 4,
              maxHeight: `calc(100dvh - ${Math.round(rect.bottom) + 12}px)`,
            }),
      });
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setPlace(null);
    };
    const resize = () => setPlace(null);
    document.addEventListener('pointerdown', away);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % items.length
        : event.key === 'ArrowUp'
          ? (index - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : -1;
    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };
  return (
    <>
      <button
        ref={button}
        id={`${id}-button`}
        className={`bar-menu${active || open ? ' active' : ''}${className ? ` ${className}` : ''}`}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <Icon size={15} aria-hidden="true" />
        <span className={hideLabel ? 'visually-hidden' : undefined}>{label}</span>
        {arrow && <ChevronDown className="bar-menu-arrow" size={13} aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          className="dock-menu"
          role="menu"
          aria-label={label}
          style={place}
          onKeyDown={move}
        >
          {actions.map(
            ({ label, icon: Icon, tone, shortcut, disabled, info, title, lang, onSelect }) => (
              <button
                key={label}
                role="menuitem"
                tabIndex={-1}
                className={info ? 'menu-info' : undefined}
                aria-disabled={disabled || info || undefined}
                title={title}
                onClick={() => {
                  if (disabled || info) return;
                  close(true);
                  onSelect();
                }}
              >
                {Icon ? <Icon size={14} aria-hidden="true" /> : <span className="menu-icon-slot" />}
                <span lang={lang} className={tone ? `tone-${tone}` : undefined}>
                  {label}
                </span>
                {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}
