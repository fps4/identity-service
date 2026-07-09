'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Boxes, KeyRound, Users, Ticket, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/applications', label: 'Applications', icon: Boxes },
  { href: '/clients', label: 'Credentials', icon: KeyRound },
  { href: '/users', label: 'Users', icon: Users },
  { href: '/invites', label: 'Invites', icon: Ticket },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 p-3">
      <div className="px-3 py-4 text-sm font-semibold">identity-service</div>
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              active ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-accent'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
