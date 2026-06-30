"use client";

import { Check, ChevronDown, Gamepad2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface SelectMenuOption {
  value: string;
  label: string;
}

export function SelectMenu({
  value,
  options,
  onChange,
  onOpenChange,
  ariaLabel,
  className = "",
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  ariaLabel: string;
  className?: string;
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
    if (!option) return;
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
        className="select-menu__trigger"
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
        <Gamepad2 size={15} aria-hidden />
        <span>{selected?.label ?? "เลือกเกม"}</span>
        <ChevronDown className="select-menu__chevron" size={15} aria-hidden />
      </button>

      {open && (
        <div className="select-menu__list" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(element) => { optionRefs.current[index] = element; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-menu__option${index === activeIndex ? " select-menu__option--active" : ""}`}
              tabIndex={index === activeIndex ? 0 : -1}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
