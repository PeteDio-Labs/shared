/**
 * Canonical Blog API types shared between mcp-homelab and blog-agent.
 */

export interface BlogPostRequest {
  title: string;
  content: string;
  excerpt: string;
  status?: 'DRAFT' | 'PUBLISHED';
  tags?: string[];
}

export interface BlogPostTag {
  id: number;
  name: string;
  slug?: string;
}

export interface BlogPostResponse {
  id: number;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: string;
  tags: BlogPostTag[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
}
