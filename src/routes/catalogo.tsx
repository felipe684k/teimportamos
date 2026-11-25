import { createFileRoute, Link } from "@tanstack/react-router";
import { jsonForScript } from "@/lib/html-escape";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Search, ArrowDownUp, X, Loader2, MessageCircle } from "lucide-react";

import { ProductCard } from "@/components/ProductCard";
import { ComboCard } from "@/components/ComboCard";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { storeQueryOptions } from "@/lib/store-query";
import {
  categoriesOf,
  orderedCategories,
  rankBestSellers,
  isYes,
  priceOf,
  isCamiseta,
  isLongSleeve,
  JERSEY_FAN_TIERS,
  JERSEY_FAN_ML_TIERS,
  sanitizeUrl,
  type Product,
} from "@/lib/store";
import { SITE_URL } from "@/lib/constants";
import { track, trackWhatsappClick } from "@/lib/analytics";

type Sort = "destacado" | "precio_asc" | "precio_desc" | "nombre";

// Permite entrar directo a un rubro (ej: /catalogo?cat=Tecnología) o a ofertas/combos (?ver=ofertas).
// Valores inválidos se ignoran en vez de romper la página.
const catalogoSearchSchema = z.object({
  cat: z.string().trim().max(60).optional().catch(undefined),
  ver: z.enum(["ofertas", "combos"]).optional().catch(undefined),
});

/** Compara nombres de categoría sin distinguir mayúsculas ni acentos. */
function normCatName(v: string) {
  return v
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Aviso para cuando la búsqueda no trae nada: invita a pedir el producto por WhatsApp.
 * El mensaje ya lleva lo que el cliente escribió en el buscador, y el clic se cuenta
 * en `whatsapp_click` con ubicacion "catalogo_sin_resultados" (producto = lo buscado).
 */
function NoResultsWhatsapp({ config, search }: { config: Record<string, string>; search: string }) {
  const phone = (config["whatsapp_individual"] ?? config["whatsapp_numero"] ?? "").replace(/\D/g, "");
  if (!phone) return null;
  const buscado = search.trim().replace(/\s+/g, " ").slice(0, 80);
  const msg = buscado
    ? `Hola! Quiero conseguir "${buscado}". Lo busqué en el catálogo y no lo encontré.`
    : "Hola! Quiero conseguir un producto que no encontré en el catálogo.";
  return (
    <div className="mt-6 w-full max-w-md rounded-2xl border border-whatsapp/40 bg-whatsapp/8 p-4 sm:p-5">
      <p className="text-sm font-bold text-foreground">¿No encontrás el producto que querés?</p>
      <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
        Escribinos al WhatsApp y te lo conseguimos.
      </p>
      <a
        id="catalogo-sin-resultados-whatsapp"
        href={sanitizeUrl(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() =>
          trackWhatsappClick({
            destino: "privado",
            ubicacion: "catalogo_sin_resultados",
            producto: buscado || null,
          })
        }
        className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl bg-whatsapp px-4 py-2.5 text-sm font-bold text-whatsapp-foreground shadow-sm transition hover:opacity-90 active:scale-95"
      >
        <MessageCircle className="h-4 w-4" fill="currentColor" />
        Pedir por WhatsApp
      </a>
    </div>
  );
}

export const Route = createFileRoute("/catalogo")({
  validateSearch: catalogoSearchSchema,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(storeQueryOptions);
  },
  head: () => ({
    meta: [
      { title: "Catálogo completo — Te importamos" },
      {
        name: "description",
        content:
          "Buscá y filtrá todo el catálogo de productos importados: tecnología, bazar, perfumes y más. Ordená por precio o por más vendidos.",
      },
      { property: "og:title", content: "Catálogo completo — Te importamos" },
      {
        property: "og:description",
        content:
          "Todo el stock de productos importados con búsqueda, filtros por categoría y orden por precio.",
      },
      { property: "og:image", content: `${SITE_URL}/businessicon.jpg` },
      { property: "og:image:secure_url", content: `${SITE_URL}/businessicon.jpg` },
      { name: "twitter:image", content: `${SITE_URL}/businessicon.jpg` },
      { property: "og:url", content: `${SITE_URL}/catalogo` },
    ],
    links: [
      { rel: "canonical", href: `${SITE_URL}/catalogo` },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: jsonForScript({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Inicio",
              item: `${SITE_URL}/`,
            },
            {
              "@type": "ListItem",
              position: 2,
              name: "Catálogo",
              item: `${SITE_URL}/catalogo`,
            },
          ],
        }),
      },
    ],
  }),
  component: Catalogo,
});

function Catalogo() {
  const { data } = useSuspenseQuery(storeQueryOptions);
  const { products, banners, config } = data;

  const { cat: catParam, ver } = Route.useSearch();
  // Categoría pedida por URL, resuelta contra las categorías reales (sin importar mayúsculas/acentos)
  const catFromUrl = useMemo(() => {
    if (!catParam) return "todas";
    const wanted = normCatName(catParam);
    return categoriesOf(products).find((c) => normCatName(c) === wanted) ?? "todas";
  }, [catParam, products]);

  const [search, setSearch] = useState("");
  const [cat, setCat] = useState(catFromUrl);
  const [sort, setSort] = useState<Sort>("destacado");
  const [onlyTop, setOnlyTop] = useState(false);
  const [onlyOffers, setOnlyOffers] = useState(ver === "ofertas");
  const [onlyCombos, setOnlyCombos] = useState(ver === "combos");

  // Si cambia la URL con la página ya abierta (ej: otro link a /catalogo?cat=...), aplicar el filtro nuevo
  useEffect(() => {
    setCat(catFromUrl);
    setOnlyOffers(ver === "ofertas");
    setOnlyCombos(ver === "combos");
  }, [catFromUrl, ver]);

  // Un solo filtro a la vez: combinarlos (ej. Ofertas + Más vendidos + Bazar) solía dejar 0 productos
  const pickFilter = (f: "todas" | "combos" | "ofertas" | "top" | { cat: string }) => {
    setOnlyCombos(f === "combos");
    setOnlyOffers(f === "ofertas");
    setOnlyTop(f === "top");
    setCat(typeof f === "object" ? f.cat : "todas");
  };

  // Al entrar a un rubro desde un link, desplazar la fila de categorías hasta que se vea el elegido
  const chipsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (catFromUrl === "todas") return;
    const row = chipsRef.current;
    const active = row?.querySelector<HTMLElement>('[data-active="true"]');
    if (row && active) row.scrollLeft = active.offsetLeft - row.offsetLeft - 12;
  }, [catFromUrl]);
  // Si se borran todos los combos mientras la pestaña está activa, vuelve al catálogo normal
  const showCombos = onlyCombos && banners.length > 0;

  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Resetear cantidad visible al cambiar cualquier filtro
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, cat, sort, onlyTop, onlyOffers, onlyCombos]);

  // Medición: qué filtros y búsquedas usan los visitantes (se omite el estado inicial)
  const filtersTrackedRef = useRef(false);
  useEffect(() => {
    if (!filtersTrackedRef.current) {
      filtersTrackedRef.current = true;
      return;
    }
    track("catalog_filter", {
      categoria: cat,
      ofertas: onlyOffers,
      mas_vendidos: onlyTop,
      combos: onlyCombos,
      orden: sort,
    });
  }, [cat, sort, onlyTop, onlyOffers, onlyCombos]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) return;
    const t = setTimeout(() => track("catalog_search", { query: q.slice(0, 100) }), 1200);
    return () => clearTimeout(t);
  }, [search]);

  const comboList = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Se conserva el índice original: /combo/$index apunta a la posición en `banners`
    return banners
      .map((b, index) => ({ b, index }))
      .filter(({ b }) => !q || (b.titulo ?? "").toLowerCase().includes(q) || (b.subtitulo ?? "").toLowerCase().includes(q));
  }, [banners, search]);

  const cats = useMemo(() => orderedCategories(products), [products]);

  // Mismo ranking de "Más vendidos" que la home: posición de cada producto y cuántos entran
  const bestSellers = useMemo(() => {
    const { ranked, topCount } = rankBestSellers(products);
    const rank = new Map<Product, number>();
    ranked.forEach((p, i) => rank.set(p, i));
    return { rank, topCount };
  }, [products]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = products.filter((p) => {
      if (cat !== "todas" && (p.categoria ?? "").trim() !== cat) return false;
      if (q) {
        const nom = (p.nombre ?? "").toLowerCase();
        const cate = (p.categoria ?? "").toLowerCase();
        const desc = (p.descripcion ?? "").toLowerCase();
        if (!nom.includes(q) && !cate.includes(q) && !desc.includes(q)) return false;
      }
      if (onlyTop && (bestSellers.rank.get(p) ?? Infinity) >= bestSellers.topCount) return false;
      if (onlyOffers && !isYes(p.oferta)) return false;
      return true;
    });

    const usdRate = Number(config?.["dolar_cotizacion"] ?? 0);
    const getSortPrice = (p: Product) => {
      if (isCamiseta(p.categoria, p.nombre) && usdRate > 0) {
        const isML = isLongSleeve(p.nombre);
        const tiers = isML ? JERSEY_FAN_ML_TIERS : JERSEY_FAN_TIERS;
        return Math.round(tiers[0].unitUsd * 1.07 * usdRate);
      }
      return priceOf(p);
    };

    return [...filtered].sort((a, b) => {
      if (sort === "precio_asc") return getSortPrice(a) - getSortPrice(b);
      if (sort === "precio_desc") return getSortPrice(b) - getSortPrice(a);
      if (sort === "nombre") return (a.nombre ?? "").localeCompare(b.nombre ?? "");
      // "destacado" (Más vendidos): el mismo orden que la home
      return (bestSellers.rank.get(a) ?? Infinity) - (bestSellers.rank.get(b) ?? Infinity);
    });
  }, [products, search, cat, sort, onlyTop, onlyOffers, config, bestSellers]);

  const visibleProducts = useMemo(() => {
    return list.slice(0, visibleCount);
  }, [list, visibleCount]);

  const hasMore = visibleCount < list.length;

  // IntersectionObserver para carga infinita suave
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first && first.isIntersecting && !isLoadingMore) {
          setIsLoadingMore(true);
          // Breve delay para renderizado suave y feedback visual
          setTimeout(() => {
            setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, list.length));
            setIsLoadingMore(false);
          }, 150);
        }
      },
      {
        rootMargin: "350px 0px", // Detectar antes de llegar al último elemento
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, list.length]);

  const chip = (active: boolean) =>
    `shrink-0 rounded-full border px-3 py-1 text-xs font-semibold sm:px-3.5 sm:py-1.5 sm:text-xs transition-all whitespace-nowrap inline-flex items-center gap-1 ${
      active
        ? "border-primary bg-primary text-primary-foreground shadow-xs font-bold"
        : "border-border/80 bg-card text-muted-foreground hover:text-foreground hover:border-border"
    }`;

  return (
    <div className="min-h-screen">
      <SiteHeader config={config} />

      <main className="mx-auto max-w-[1180px] px-3.5 py-5 sm:px-6 sm:py-8">
        <div className="mb-3">
          <p className="inline-flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold uppercase tracking-[2px] text-amber">
            <span className="grad-urgente h-0.5 w-3.5 rounded" />
            Todo el stock
          </p>
          <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight">Catálogo completo</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground">
            Buscá por producto o categoría, filtrá y ordená según tu conveniencia.
          </p>
        </div>

        {/* Panel compacto de búsqueda y filtros sticky */}
        <div className="sticky top-[57px] z-30 -mx-3.5 mb-3 bg-background/95 px-3.5 py-2 backdrop-blur-md border-b border-border/40 shadow-xs sm:mx-0 sm:px-0 sm:border-0 sm:shadow-none">
          <div className="space-y-2">
            {/* Fila 1: Búsqueda + Selector de orden en una sola línea */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por producto o categoría..."
                  // Sin la "×" propia del navegador: ya está la nuestra (antes se veían dos)
                  className="h-8.5 sm:h-9.5 w-full rounded-lg border border-input bg-card pl-8 pr-7 text-xs sm:text-sm outline-none focus:border-primary transition-colors [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="relative shrink-0">
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as Sort)}
                  className="h-8.5 sm:h-9.5 rounded-lg border border-input bg-card pl-2.5 pr-6 text-[11px] sm:text-xs font-semibold outline-none focus:border-primary appearance-none cursor-pointer"
                >
                  <option value="destacado">Más vendidos</option>
                  <option value="precio_asc">Menor precio</option>
                  <option value="precio_desc">Mayor precio</option>
                  <option value="nombre">Nombre A-Z</option>
                </select>
                <ArrowDownUp className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            {/* Fila 2: Chips de categorías y filtros en una sola línea con scroll horizontal suave */}
            <div
              ref={chipsRef}
              className="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-0.5 -mx-3.5 px-3.5 sm:mx-0 sm:px-0 sm:flex-wrap"
            >
              <button className={chip(cat === "todas" && !onlyOffers && !onlyTop && !showCombos)} onClick={() => pickFilter("todas")}>
                Todas
              </button>
              {banners.length > 0 && (
                <button className={chip(showCombos)} onClick={() => pickFilter(showCombos ? "todas" : "combos")}>
                  Combos
                </button>
              )}
              <button className={chip(onlyOffers)} onClick={() => pickFilter(onlyOffers ? "todas" : "ofertas")}>
                Ofertas
              </button>
              <button className={chip(onlyTop)} onClick={() => pickFilter(onlyTop ? "todas" : "top")}>
                Más vendidos
              </button>
              {cats.map((c) => (
                <button key={c} data-active={cat === c} className={chip(cat === c)} onClick={() => pickFilter(cat === c ? "todas" : { cat: c })}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-3 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
          <span>
            {showCombos
              ? `${comboList.length} ${comboList.length === 1 ? "combo" : "combos"}`
              : list.length ? `Mostrando ${visibleProducts.length} de ${list.length} ${list.length === 1 ? "producto" : "productos"}` : "0 productos"}
          </span>
        </div>

        {/* Banner WhatsApp: en todas las categor\u00edas */}
        {(() => {
          const phone = (config["whatsapp_individual"] ?? config["whatsapp_numero"] ?? "").replace(/\D/g, "");
          if (!phone) return null;
          const catName = cat && !showCombos ? cat.trim().slice(0, 60) : "";
          const msg = encodeURIComponent(
            catName
              ? `Hola! Estaba viendo ${catName} en el catálogo y no encontré lo que buscaba. ¿Me podés ayudar?`
              : "Hola! Estaba viendo el catálogo y no encontré lo que buscaba. ¿Me podés ayudar?",
          );
          const waUrl = `https://wa.me/${phone}?text=${msg}`;
          return (
            <a
              id="banner-catalogo-whatsapp"
              onClick={() => trackWhatsappClick({ destino: "privado", ubicacion: "catalogo" })}
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-5 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/8 px-4 py-3.5 transition-all hover:bg-primary/14 hover:border-primary/50 hover:shadow-sm sm:gap-4 sm:px-5 sm:py-4"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary sm:h-10 sm:w-10">
                <MessageCircle className="h-4.5 w-4.5 sm:h-5 sm:w-5" fill="currentColor" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider text-primary sm:text-xs">
                  ¿No encontrás lo que buscás?
                </p>
                <p className="mt-0.5 text-xs text-foreground/80 sm:text-[13px]">
                  Tenemos modelos que no siempre están en el catálogo online.{" "}
                  <span className="font-semibold text-foreground">Consultanos por WhatsApp</span> y lo conseguimos.
                </p>
              </div>
              <span className="shrink-0 rounded-xl bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 sm:px-4 sm:py-2 sm:text-xs">
                Escribir →
              </span>
            </a>
          );
        })()}

        {showCombos ? (
          comboList.length ? (
            // Misma grilla que los productos para que los combos no se vean gigantes en móvil
            <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
              {comboList.map(({ b, index }) => (
                <ComboCard key={b.id ?? index} banner={b} index={index} config={config} />
              ))}
            </div>
          ) : (
            <div className="my-10 flex flex-col items-center text-center">
              <p className="text-sm text-muted-foreground">
                No hay combos que coincidan con "{search}".
              </p>
              <NoResultsWhatsapp config={config} search={search} />
            </div>
          )
        ) : list.length ? (
          <>
            <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
              {visibleProducts.map((p, i) => (
                <ProductCard key={p.id ?? i} p={p} config={config} index={i} />
              ))}
            </div>

            {/* Sentinel para IntersectionObserver */}
            {hasMore && <div ref={sentinelRef} className="h-6 w-full" />}

            {/* Indicador de carga */}
            {isLoadingMore && (
              <div className="my-8 flex flex-col items-center justify-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-xs font-medium text-muted-foreground">Cargando más productos...</p>
              </div>
            )}

            {/* Mensaje de fin de catálogo */}
            {!hasMore && list.length > PAGE_SIZE && (
              <div className="mt-10 flex items-center justify-center gap-3 text-xs font-semibold text-muted-foreground/60">
                <span className="h-px w-12 bg-border/60" />
                <span>Fin del catálogo</span>
                <span className="h-px w-12 bg-border/60" />
              </div>
            )}
          </>
        ) : (
          <div className="my-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/60 p-8 text-center sm:p-12">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Search className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-foreground">No encontramos productos</h3>
            <p className="mt-1 max-w-md text-xs sm:text-sm text-muted-foreground">
              {search && cat !== "todas" ? (
                <>
                  No hay resultados para <span className="font-semibold text-foreground">"{search}"</span> dentro de <span className="font-semibold text-foreground">"{cat}"</span>.
                </>
              ) : search ? (
                <>
                  No hay productos que coincidan con <span className="font-semibold text-foreground">"{search}"</span>.
                </>
              ) : (
                "No hay productos disponibles con los filtros seleccionados."
              )}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {search && cat !== "todas" && (
                <button
                  type="button"
                  onClick={() => setCat("todas")}
                  className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-xs transition hover:opacity-90 active:scale-95"
                >
                  Buscar "{search}" en todas las categorías
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setCat("todas");
                  setOnlyOffers(false);
                  setOnlyTop(false);
                  setOnlyCombos(false);
                }}
                className="rounded-lg border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground transition hover:bg-muted active:scale-95"
              >
                Limpiar filtros
              </button>
            </div>
            <NoResultsWhatsapp config={config} search={search} />
          </div>
        )}

        <div className="mt-10 flex justify-center">
          <Link to="/" className="btn-base border border-border text-foreground">
            ← Volver al inicio
          </Link>
        </div>
      </main>

      <SiteFooter config={config} />
    </div>
  );
}
