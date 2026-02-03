// /opt/content360/core/schemas.js

const QUICK_BOOST_SCHEMA = {
  name: "content360_quick_boost",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", const: "quick_boost" },
      title: { type: "string", minLength: 15, maxLength: 70 },
      meta_description: { type: "string", minLength: 120, maxLength: 170 },
      intro: { type: "string", minLength: 120, maxLength: 600 },
      h2: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: { type: "string", minLength: 6, maxLength: 80 }
      },
      faq: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", minLength: 8, maxLength: 120 },
            a: { type: "string", minLength: 20, maxLength: 300 }
          },
          required: ["q", "a"]
        }
      },
      seo: {
        type: "object",
        additionalProperties: false,
        properties: {
          focus_keyword: { type: "string", minLength: 3, maxLength: 40 },
          tags: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 2, maxLength: 30 }
          }
        },
        required: ["focus_keyword", "tags"]
      }
    },
    required: ["mode", "title", "meta_description", "intro", "h2", "faq", "seo"]
  }
};

const FULL_CONTENT_SCHEMA = {
  name: "content360_full_content",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", const: "full_content" },
      title: { type: "string", minLength: 15, maxLength: 80 },
      meta_description: { type: "string", minLength: 120, maxLength: 170 },
      outline: {
        type: "array",
        minItems: 3,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            h2: { type: "string", minLength: 6, maxLength: 80 },
            bullets: {
              type: "array",
              minItems: 2,
              maxItems: 5,
              items: { type: "string", minLength: 6, maxLength: 120 }
            },
            notes: { type: "string", minLength: 0, maxLength: 160 }
          },
          required: ["h2", "bullets", "notes"]
        }
      },
      content_html: { type: "string", minLength: 600, maxLength: 12000 },
      faq: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", minLength: 8, maxLength: 120 },
            a: { type: "string", minLength: 30, maxLength: 450 }
          },
          required: ["q", "a"]
        }
      },
      seo: {
        type: "object",
        additionalProperties: false,
        properties: {
          focus_keyword: { type: "string", minLength: 3, maxLength: 40 },
          tags: {
            type: "array",
            minItems: 3,
            maxItems: 12,
            items: { type: "string", minLength: 2, maxLength: 30 }
          },
          slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
          meta_title: { type: "string", minLength: 35, maxLength: 75 },
          internal_links: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                anchor: { type: "string", minLength: 2, maxLength: 60 },
                url: { type: "string", minLength: 1, maxLength: 400 }
              },
              required: ["anchor", "url"]
            }
          },
          image_alts: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            items: { type: "string", minLength: 6, maxLength: 120 }
          }
        },
        required: ["focus_keyword", "tags", "slug", "meta_title", "internal_links", "image_alts"]
      },
      checks: {
        type: "object",
        additionalProperties: false,
        properties: {
          tone: { type: "string", minLength: 2, maxLength: 40 },
          plagiarism_risk: { enum: ["low", "medium", "high"] },
          readability: { enum: ["easy", "medium", "hard"] }
        },
        required: ["tone", "plagiarism_risk", "readability"]
      }
    },
    required: ["mode", "title", "meta_description", "outline", "content_html", "faq", "seo", "checks"]
  }
};

const ECOM_CATALOG_SCHEMA = {
  name: "content360_ecom_catalog",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", const: "ecom_catalog" },
      product: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 10, maxLength: 90 },
          short_description: { type: "string", minLength: 40, maxLength: 240 },
          long_description_html: { type: "string", minLength: 400, maxLength: 9000 },
          benefits: {
            type: "array",
            minItems: 3,
            maxItems: 8,
            items: { type: "string", minLength: 6, maxLength: 120 }
          },
          specs: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                k: { type: "string", minLength: 2, maxLength: 40 },
                v: { type: "string", minLength: 1, maxLength: 80 }
              },
              required: ["k", "v"]
            }
          },
          usage: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            items: { type: "string", minLength: 6, maxLength: 140 }
          },
          faq: {
            type: "array",
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                q: { type: "string", minLength: 8, maxLength: 120 },
                a: { type: "string", minLength: 30, maxLength: 450 }
              },
              required: ["q", "a"]
            }
          },
          cross_sell_copy: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: { type: "string", minLength: 8, maxLength: 120 }
          }
        },
        required: ["title", "short_description", "long_description_html", "benefits", "specs", "usage", "faq", "cross_sell_copy"]
      },
      seo: {
        type: "object",
        additionalProperties: false,
        properties: {
          focus_keyword: { type: "string", minLength: 3, maxLength: 40 },
          tags: {
            type: "array",
            minItems: 3,
            maxItems: 12,
            items: { type: "string", minLength: 2, maxLength: 30 }
          },
          meta_title: { type: "string", minLength: 35, maxLength: 75 },
          meta_description: { type: "string", minLength: 120, maxLength: 170 }
        },
        required: ["focus_keyword", "tags", "meta_title", "meta_description"]
      }
    },
    required: ["mode", "product", "seo"]
  }
};

module.exports = {
  QUICK_BOOST_SCHEMA,
  FULL_CONTENT_SCHEMA,
  ECOM_CATALOG_SCHEMA
};
