import {
  MessageSquareText,
  Globe,
  Users,
  BarChart3,
  LayoutDashboard,
  Home,
  type LucideIcon,
} from 'lucide-react';

export type ViewId =
  | 'landing'
  | 'chat'
  | 'scraping'
  | 'agents'
  | 'analytics';

export interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'chat',
    label: 'Chat Engine',
    description: 'Aider-style coding panel',
    icon: MessageSquareText,
  },
  {
    id: 'scraping',
    label: 'Web Scraping',
    description: 'Crawl4AI + Steel Browser',
    icon: Globe,
  },
  {
    id: 'agents',
    label: 'Agent Team Hub',
    description: 'CrewAI + Dify canvas',
    icon: Users,
  },
  {
    id: 'analytics',
    label: 'Performance',
    description: 'Langfuse metrics',
    icon: BarChart3,
  },
];

export const DASHBOARD_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  home: Home,
};
