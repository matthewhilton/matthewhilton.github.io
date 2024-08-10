import type { Metadata, Site, Socials } from "@types";

export const SITE: Site = {
  TITLE: "Matthew Hilton",
  DESCRIPTION: "Full stack developer",
  EMAIL: "mj.hilton@outlook.com",
  NUM_POSTS_ON_HOMEPAGE: 5,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION: "Astro Micro is an accessible theme for Astro.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION: "A collection of articles on topics I am passionate about.",
};

export const SOCIALS: Socials = [
  {
    NAME: "GitHub",
    HREF: "https://github.com/matthewhilton",
  },
];
