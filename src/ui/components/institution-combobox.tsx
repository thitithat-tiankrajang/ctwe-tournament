"use client";

import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useId, useMemo, useState } from "react";

export interface CustomComboboxOption {
  value: string;
  label: string;
  detail?: string;
}

interface CustomComboboxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: CustomComboboxOption[];
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  caption?: string;
  emptyMessage?: string;
  listLabel?: string;
  openButtonLabel?: string;
  closeButtonLabel?: string;
  "aria-describedby"?: string;
}

export function CustomCombobox({
  id,
  value,
  onChange,
  options,
  disabled = false,
  loading = false,
  placeholder = "ค้นหาหรือพิมพ์ข้อมูล",
  caption = "รายการที่มีอยู่",
  emptyMessage = "ไม่พบรายการที่ตรงกัน",
  listLabel = "รายการตัวเลือก",
  openButtonLabel = "เปิดรายการตัวเลือก",
  closeButtonLabel = "ปิดรายการตัวเลือก",
  "aria-describedby": describedBy,
}: CustomComboboxProps) {
  const listId = `${useId()}-options`;
  const [open, setOpen] = useState(false);
  const available = useMemo(() => {
    const needle = value.trim().toLocaleLowerCase("th");
    const unique = new Map(options.map((option) => [option.value, option]));
    return [...unique.values()]
      .filter((option) => `${option.value} ${option.label} ${option.detail ?? ""}`.toLocaleLowerCase("th").includes(needle))
      .sort((a, b) => a.label.localeCompare(b.label, "th"));
  }, [options, value]);
  const hasOptions = options.length > 0;

  const choose = (option: CustomComboboxOption) => {
    onChange(option.value);
    setOpen(false);
  };

  return (
    <div className={`institution-combobox${open ? " institution-combobox--open" : ""}`}>
      <div className="institution-combobox__control">
        <input
          id={id}
          className="input"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          role={hasOptions ? "combobox" : undefined}
          aria-autocomplete={hasOptions ? "list" : undefined}
          aria-expanded={hasOptions ? open : undefined}
          aria-controls={hasOptions ? listId : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue);
            if (hasOptions) setOpen(!options.some((option) => option.value.toLocaleLowerCase("th") === nextValue.trim().toLocaleLowerCase("th")));
          }}
          onFocus={() => hasOptions && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 0)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "ArrowDown" && hasOptions) setOpen(true);
            if (event.key === "Enter" && open && available.length === 1) {
              event.preventDefault();
              choose(available[0]);
            }
          }}
        />
        {loading ? <LoaderCircle className="loading-spinner" size={17} aria-label="กำลังโหลด" /> : hasOptions ? (
          <button
            type="button"
            className="institution-combobox__toggle"
            aria-label={open ? closeButtonLabel : openButtonLabel}
            aria-expanded={open}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown size={17} />
          </button>
        ) : null}
      </div>
      {hasOptions && open && (
        <div className="institution-combobox__menu" id={listId} role="listbox" aria-label={listLabel}>
          <div className="institution-combobox__caption">{caption}</div>
          {available.length > 0 ? available.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={value === option.value}
              className="institution-combobox__option"
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <span className="institution-combobox__option-text"><b>{option.label}</b>{option.detail && <small>{option.detail}</small>}</span>
              {value === option.value && <Check size={15} />}
            </button>
          )) : <div className="institution-combobox__empty">{emptyMessage}</div>}
        </div>
      )}
    </div>
  );
}

interface InstitutionComboboxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  "aria-describedby"?: string;
}

export function InstitutionCombobox({ options, ...props }: InstitutionComboboxProps) {
  return (
    <CustomCombobox
      {...props}
      options={options.map((option) => ({ value: option, label: option }))}
      placeholder={props.placeholder ?? "พิมพ์ชื่อโรงเรียนหรือสถาบัน"}
      caption="สถาบันที่มีในรายการ"
      emptyMessage="ไม่พบรายการเดิม — ใช้ชื่อใหม่ที่พิมพ์ได้เลย"
      listLabel="สถาบันที่เคยใช้"
      openButtonLabel="เปิดรายการสถาบัน"
      closeButtonLabel="ปิดรายการสถาบัน"
    />
  );
}
