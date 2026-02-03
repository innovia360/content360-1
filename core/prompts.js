// /opt/content360/core/prompts.js

function safeStr(x) {
  if (x === null || x === undefined) return "";
  return String(x);
}

function buildContext(reqJson) {
  // Ces champs doivent venir du plugin (ou du WP site) : adapte si besoin
  const entity_type = safeStr(reqJson.entity_type || reqJson.entity || "page");
  const entity_id = safeStr(reqJson.entity_id || reqJson.wp_id || "");
  const lang = safeStr(reqJson.lang || "fr");

  const source_title = safeStr(reqJson.source_title || reqJson.title || "");
  const source_excerpt = safeStr(reqJson.source_excerpt || reqJson.excerpt || "");
  const source_taxonomy = safeStr(reqJson.source_taxonomy || "");
  const source_facts = safeStr(reqJson.source_facts || "");
  const source_specs = safeStr(reqJson.source_specs || "");
  const source_usage = safeStr(reqJson.source_usage || "");
  const intent = safeStr(reqJson.intent || "");

  return {
    entity_type, entity_id, lang,
    source_title, source_excerpt, source_taxonomy,
    source_facts, source_specs, source_usage,
    intent
  };
}

function promptQuickBoost(reqJson) {
  const c = buildContext(reqJson);
  return [
    `Tu es Content360, assistant e-commerce/SEO.`,
    `But: produire un “Quick Boost” (2 minutes) pour optimiser une page ou un produit SANS réécrire tout le contenu.`,
    ``,
    `Contexte:`,
    `- entity_type: ${c.entity_type}`,
    `- entity_id: ${c.entity_id}`,
    `- langue: ${c.lang}`,
    `- titre/source: ${c.source_title}`,
    `- extrait/source: ${c.source_excerpt}`,
    `- catégories/tags/source: ${c.source_taxonomy}`,
    ``,
    `Contraintes:`,
    `- Réponse STRICTEMENT JSON conforme au schéma fourni (aucun texte hors JSON).`,
    `- Pas de promesses non vérifiables (ex: "livraison 24h") si non fourni. Préfère une réassurance générique.`,
    `- Meta description: 140–160 caractères.`,
    `- H2: 3 à 6 titres courts, non redondants.`,
    `- FAQ: 0 à 4 questions max, concrètes.`,
    `- Focus keyword: 2 à 4 mots max.`
  ].join("\n");
}

function promptFullContent(reqJson) {
  const c = buildContext(reqJson);
  return [
    `Tu es Content360, assistant e-commerce/SEO.`,
    `But: produire un contenu COMPLET prêt à publier (5–8 min), structuré, utile, sans blabla.`,
    ``,
    `Contexte:`,
    `- entity_type: ${c.entity_type}`,
    `- entity_id: ${c.entity_id}`,
    `- langue: ${c.lang}`,
    `- titre/source: ${c.source_title}`,
    `- brief/intention: ${c.intent}`,
    `- extrait/source: ${c.source_excerpt}`,
    `- éléments factuels: ${c.source_facts}`,
    ``,
    `Contraintes:`,
    `- Réponse STRICTEMENT JSON conforme au schéma.`,
    `- content_html: HTML simple (p, h2, ul, li, strong). Pas de styles inline.`,
    `- meta_title: 45–65 caractères.`,
    `- meta_description: 140–160 caractères.`,
    `- slug: kebab-case, sans accents, 3–8 mots.`,
    `- image_alts: 2 à 8 (sans inventer des photos).`,
    `- checks.plagiarism_risk: low|medium|high (prudence).`
  ].join("\n");
}

function promptEcomCatalog(reqJson) {
  const c = buildContext(reqJson);
  return [
    `Tu es Content360, assistant e-commerce WooCommerce.`,
    `But: générer les éléments produit (courte, longue, bénéfices, specs, usage, cross-sell) + SEO.`,
    ``,
    `Contexte:`,
    `- entity_type: product`,
    `- entity_id: ${c.entity_id}`,
    `- langue: ${c.lang}`,
    `- nom produit/source: ${c.source_title}`,
    `- specs/source: ${c.source_specs}`,
    `- usage/source: ${c.source_usage}`,
    ``,
    `Contraintes:`,
    `- Réponse STRICTEMENT JSON conforme au schéma.`,
    `- short_description: 1–2 phrases (max 240 chars).`,
    `- long_description_html: HTML simple (p, h2, ul, li, strong).`,
    `- specs: si specs/source est vide, specs doit être [].`,
    `- meta_title: 45–65 chars, meta_description: 140–160 chars.`
  ].join("\n");
}

module.exports = {
  promptQuickBoost,
  promptFullContent,
  promptEcomCatalog
};
