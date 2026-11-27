import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, subtitle, description, actions, className = "" }: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; description?: string; actions?: ReactNode; className?: string }) {
  return (
    // The accepted design's page head; legacy class names stay as hooks for page-specific rules.
    <header className={`page-head page-header${className ? ` ${className}` : ""}`}>
      <div className="ttl">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {subtitle && <span className="desc page-subtitle">{subtitle}</span>}
        {description && <span className="desc page-description">{description}</span>}
      </div>
      {actions && <div className="actions page-actions">{actions}</div>}
    </header>
  );
}

export function Panel({ title, description, actions, children, className = "", id }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`panel ${className}`}>
      {(title || actions) && (
        <div className="panel__header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
