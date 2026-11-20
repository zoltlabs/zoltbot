/** Icons the sidebar draws. They're decorative; every button carries its own name. */

export function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <circle cx="8.5" cy="8.5" r="5.5" stroke-width="1.6" />
      <path d="m12.7 12.7 3.6 3.6" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  );
}

export function MapIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="m3.5 5.2 4.2-1.7 4.6 1.8 4.2-1.7v11.2l-4.2 1.7-4.6-1.8-4.2 1.7V5.2Z"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
      <path d="M7.7 3.5v11.3M12.3 5.3v11.3" stroke-width="1.4" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[18px] fill-none stroke-current">
      <path d="M10 4v12M4 10h12" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

export function SidebarToggleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="sidebar-toggle-icon">
      <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.25" />
      <path d="M7.25 3.75v12.5" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path d="m12.6 4.2 3.2 3.2-8.7 8.7-3.8.6.6-3.8 8.7-8.7Z" stroke-width="1.4" />
      <path d="m10.9 5.9 3.2 3.2" stroke-width="1.4" />
    </svg>
  );
}

export function DeleteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M4.5 6.2h11M8 3.8h4M6.2 6.2l.7 9.3h6.2l.7-9.3M8.4 8.7v4.5M11.6 8.7v4.5"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function UsageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M4.2 13.9a6.5 6.5 0 1 1 11.6 0" />
      <path d="m10 10 3.1-2.3" />
      <circle cx="10" cy="10" r="1" class="account-menu-icon-fill" />
    </svg>
  );
}

export function FeedbackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M4 5.2h12v8.6H9l-3.5 2.4v-2.4H4V5.2Z" />
      <path d="M7 8.2h6M7 10.8h4" />
    </svg>
  );
}

export function MessageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M3.8 4.8h12.4v10.4H3.8V4.8Z" />
      <path d="m4.5 5.6 5.5 4.2 5.5-4.2" />
    </svg>
  );
}

export function UpdateIcon(props: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="account-menu-icon"
      classList={{ "account-menu-icon-spinning": props.active }}
    >
      <path d="M15.4 6.8A6 6 0 1 0 16 10" />
      <path d="M15.4 3.8v3h-3" />
    </svg>
  );
}

export function AccountIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <circle cx="10" cy="7.4" r="3" />
      <path d="M4.6 16.2c.8-2.7 2.9-4.2 5.4-4.2s4.6 1.5 5.4 4.2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="m6 6 8 8M14 6l-8 8" />
    </svg>
  );
}

export function PermissionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M10 2.9 15.5 5v4.6c0 3.6-2.2 6.3-5.5 7.5-3.3-1.2-5.5-3.9-5.5-7.5V5L10 2.9Z" />
      <path d="m7.6 9.9 1.5 1.5 3.3-3.4" />
    </svg>
  );
}

export function TasksIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path d="m3.8 5.6 1.4 1.4 2.4-2.6" stroke-width="1.4" stroke-linecap="round" />
      <path d="m3.8 12.6 1.4 1.4 2.4-2.6" stroke-width="1.4" stroke-linecap="round" />
      <path d="M10 5.8h6.2M10 12.8h6.2" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="sidebar-chevron fill-none stroke-current">
      <path d="m7.5 5 5 5-5 5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function ModelsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <rect x="3.5" y="3.5" width="13" height="5" rx="1.5" stroke-width="1.4" />
      <rect x="3.5" y="11.5" width="13" height="5" rx="1.5" stroke-width="1.4" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-current">
      <circle cx="5" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="15" cy="10" r="1.4" />
    </svg>
  );
}

export function RenameIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path d="M4 10h7M4 6h9M4 14h4" stroke-width="1.4" stroke-linecap="round" />
      <path d="M15 5v10M13.5 5h3M13.5 15h3" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}
