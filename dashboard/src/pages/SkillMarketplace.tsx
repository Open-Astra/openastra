import { useState } from "react";
import {
  Store,
  Search,
  Download,
  Star,
  Shield,
  CheckCircle2,
  Package,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TrustLevel = "official" | "verified" | "community" | "untrusted";
type SkillCategory = "analyze" | "transform" | "execute" | "communicate" | "search";

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  version: string;
  publisher: string;
  trustLevel: TrustLevel;
  downloads: number;
  rating: number;
  installed: boolean;
  tags: string[];
}

const mockSkills: MarketplaceSkill[] = [
  { id: "seo_site_audit", name: "SEO Site Audit", description: "Comprehensive website SEO auditing — crawls pages, checks meta tags, headings, images, links, and structured data.", category: "analyze", version: "1.0.0", publisher: "OpenAstra", trustLevel: "official", downloads: 4520, rating: 4.8, installed: true, tags: ["seo", "audit", "crawl"] },
  { id: "seo_keyword_rank", name: "SEO Keyword Rank Tracker", description: "Tracks search engine ranking positions for specified keywords with historical trends.", category: "analyze", version: "1.0.0", publisher: "OpenAstra", trustLevel: "official", downloads: 3890, rating: 4.7, installed: true, tags: ["seo", "keywords", "serp"] },
  { id: "cloud_resource_scan", name: "Cloud Resource Scanner", description: "Scans AWS/GCP/Azure infrastructure to inventory resources, detect waste, and flag security issues.", category: "analyze", version: "1.0.0", publisher: "OpenAstra", trustLevel: "official", downloads: 5210, rating: 4.9, installed: true, tags: ["cloud", "aws", "security"] },
  { id: "cloud_cost_anomaly", name: "Cloud Cost Anomaly Detector", description: "Statistical analysis of cloud spending to detect cost spikes and forecast future expenses.", category: "analyze", version: "1.0.0", publisher: "OpenAstra", trustLevel: "official", downloads: 4100, rating: 4.6, installed: true, tags: ["cloud", "cost", "anomaly"] },
  { id: "cloud_drift_detect", name: "Cloud Drift Detector", description: "Compares live infrastructure against IaC state to find configuration drift and compliance violations.", category: "analyze", version: "1.0.0", publisher: "OpenAstra", trustLevel: "official", downloads: 3750, rating: 4.8, installed: false, tags: ["cloud", "terraform", "drift"] },
  { id: "seo_content_gap", name: "SEO Content Gap Analyzer", description: "Identifies content opportunities by analyzing competitor keyword coverage.", category: "analyze", version: "1.0.0", publisher: "OpenAstra", trustLevel: "official", downloads: 2900, rating: 4.5, installed: false, tags: ["seo", "content", "competition"] },
  { id: "slack_notifier", name: "Slack Notifications", description: "Sends formatted notifications to Slack channels for workflow events and alerts.", category: "communicate", version: "2.1.0", publisher: "IntegrateHub", trustLevel: "verified", downloads: 8400, rating: 4.4, installed: false, tags: ["slack", "notifications", "alerts"] },
  { id: "github_pr_review", name: "GitHub PR Reviewer", description: "Automated code review on GitHub pull requests with inline suggestions.", category: "execute", version: "1.3.0", publisher: "DevToolsCo", trustLevel: "verified", downloads: 6200, rating: 4.6, installed: false, tags: ["github", "code-review", "ci"] },
  { id: "jira_sync", name: "Jira Sync", description: "Bi-directional sync between agent tasks and Jira issues with status updates.", category: "execute", version: "1.0.2", publisher: "WorkflowPro", trustLevel: "community", downloads: 1800, rating: 4.1, installed: false, tags: ["jira", "project-management", "sync"] },
  { id: "pdf_extractor", name: "PDF Data Extractor", description: "Extracts structured data from PDF documents using OCR and layout analysis.", category: "transform", version: "0.9.1", publisher: "DataForge", trustLevel: "community", downloads: 950, rating: 3.9, installed: false, tags: ["pdf", "ocr", "extraction"] },
];

const trustBadge: Record<TrustLevel, { label: string; color: string; icon: typeof Shield }> = {
  official: { label: "Official", color: "text-sky-400 bg-sky-400/10", icon: Shield },
  verified: { label: "Verified", color: "text-emerald-400 bg-emerald-400/10", icon: CheckCircle2 },
  community: { label: "Community", color: "text-amber-400 bg-amber-400/10", icon: Package },
  untrusted: { label: "Untrusted", color: "text-zinc-500 bg-zinc-700/50", icon: Package },
};

const categoryColors: Record<SkillCategory, string> = {
  analyze: "text-violet-400",
  transform: "text-sky-400",
  execute: "text-emerald-400",
  communicate: "text-amber-400",
  search: "text-pink-400",
};

export default function SkillMarketplacePage() {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<SkillCategory | "all">("all");
  const [trustFilter, setTrustFilter] = useState<TrustLevel | "all">("all");

  const filtered = mockSkills.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.description.toLowerCase().includes(search.toLowerCase())) return false;
    if (categoryFilter !== "all" && s.category !== categoryFilter) return false;
    if (trustFilter !== "all" && s.trustLevel !== trustFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Skill Marketplace</h1>
          <p className="text-sm text-zinc-400 mt-1">Browse, install, and manage signed skill packages</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Package className="w-4 h-4" />
          <span>{mockSkills.filter((s) => s.installed).length} installed</span>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills..."
            className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as SkillCategory | "all")}
          className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300 focus:outline-none"
        >
          <option value="all">All Categories</option>
          <option value="analyze">Analyze</option>
          <option value="transform">Transform</option>
          <option value="execute">Execute</option>
          <option value="communicate">Communicate</option>
          <option value="search">Search</option>
        </select>
        <select
          value={trustFilter}
          onChange={(e) => setTrustFilter(e.target.value as TrustLevel | "all")}
          className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300 focus:outline-none"
        >
          <option value="all">All Trust Levels</option>
          <option value="official">Official</option>
          <option value="verified">Verified</option>
          <option value="community">Community</option>
        </select>
      </div>

      {/* Skills Grid */}
      <div className="grid grid-cols-2 gap-4">
        {filtered.map((skill) => {
          const badge = trustBadge[skill.trustLevel];
          const BadgeIcon = badge.icon;
          return (
            <div key={skill.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-zinc-200">{skill.name}</h3>
                    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5", badge.color)}>
                      <BadgeIcon className="w-2.5 h-2.5" />{badge.label}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{skill.description}</p>
                </div>
                {skill.installed ? (
                  <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Installed</span>
                ) : (
                  <button className="text-xs text-sky-400 bg-sky-400/10 hover:bg-sky-400/20 px-2 py-0.5 rounded transition-colors">
                    Install
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3 mt-3 text-xs text-zinc-500">
                <span className={cn("font-medium", categoryColors[skill.category])}>{skill.category}</span>
                <span>v{skill.version}</span>
                <span className="flex items-center gap-0.5"><Download className="w-3 h-3" />{skill.downloads.toLocaleString()}</span>
                <span className="flex items-center gap-0.5"><Star className="w-3 h-3 text-amber-400" />{skill.rating}</span>
                <span>{skill.publisher}</span>
              </div>

              <div className="flex items-center gap-1.5 mt-2">
                {skill.tags.map((tag) => (
                  <span key={tag} className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-500">{tag}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <Store className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No skills match your filters</p>
        </div>
      )}
    </div>
  );
}
