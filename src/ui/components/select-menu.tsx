"use client";

import { Check, ChevronDown, Gamepad2, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface SelectMenuOption {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export function SelectMenu({
  value,
  options,
  onChange,
  onOpenChange,
  ariaLabel,
  className = "",
  icon,
  disclosureIcon: DisclosureIcon = ChevronDown,
  appearance,
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  ariaLabel: string;
  className?: string;
  icon?: LucideIcon;
  disclosureIcon?: LucideIcon;
  appearance?: "prototype";
}) {
  const listId = `${useId()}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex];
  const prototype = appearance === "prototype";
  // The accepted design shows a plain value + chevron; an icon appears only when a caller asks.
  const Icon = icon ?? (prototype ? null : Gamepad2);

  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  const openAt = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setActiveIndex(index);
    setOpen(false);
    rootRef.current?.querySelector<HTMLButtonElement>(".select-menu__trigger")?.focus();
  };

  const move = (offset: number) => {
    if (options.length === 0) return;
    const next = (activeIndex + offset + options.length) % options.length;
    setActiveIndex(next);
  };

  return (
    <div
      ref={rootRef}
      className={`select-menu${open ? " select-menu--open" : ""}${className ? ` ${className}` : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          rootRef.current?.querySelector<HTMLButtonElement>(".select-menu__trigger")?.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          if (open) move(1); else openAt(selectedIndex);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          if (open) move(-1); else openAt(selectedIndex);
        } else if (event.key === "Home" && open) {
          event.preventDefault();
          setActiveIndex(0);
        } else if (event.key === "End" && open) {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        }
      }}
    >
      <button
        type="button"
        className={`select-menu__trigger${prototype ? " sm" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={options.length === 0}
        onClick={() => {
          if (!open) setActiveIndex(selectedIndex);
          setOpen((current) => !current);
        }}
      >
        {Icon && <Icon size={15} className={prototype ? "i" : undefined} aria-hidden />}
        <span className={prototype ? "sm__v" : undefined}>{selected?.label ?? "เลือกเกม"}</span>
        <DisclosureIcon className={prototype ? "i sm__chev" : "select-menu__chevron"} size={15} aria-hidden />
      </button>

      {open && (
        <div className={`select-menu__list${prototype ? " lb prototype-select-list" : ""}`} id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(element) => { optionRefs.current[index] = element; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`select-menu__option${prototype ? " lb__opt" : ""}${index === activeIndex ? " select-menu__option--active" : ""}`}
              tabIndex={index === activeIndex ? 0 : -1}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className={prototype ? "lb__l" : undefined}>{option.label}</span>
              {option.detail && <small className={prototype ? "lb__d" : undefined}>{option.detail}</small>}
              {option.value === value && <Check size={14} className={prototype ? "i lb__ck" : undefined} aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
