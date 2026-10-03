import { createServerFn } from "@tanstack/react-start";

/**
 * Orígenes permitidos para back_urls de MercadoPago (CWE-601 — Open Redirect).
 * data.origin viene del cliente y NO se puede confiar en él sin validación.
 */
const ALLOWED_ORIGINS = new Set([
  "https://www.teimportamosarg.com",
  "https://teimportamosarg.com",
]);
const FALLBACK_ORIGIN = "https://www.teimportamosarg.com";

function safeOrigin(raw: string): string {
  try {
    const parsed = new URL(raw);
    // Normalizar: solo scheme + host (sin path, sin query, sin credenciales)
    const normalized = `${parsed.protocol}//${parsed.host}`;
    return ALLOWED_ORIGINS.has(normalized) ? normalized : FALLBACK_ORIGIN;
  } catch {
    return FALLBACK_ORIGIN;
  }
}
import {
  findProduct,
  priceOf,
  unitPriceFor,
  parseCategoryRules,
  categoryDiscountForUnits,
  findRuleForCat,
  normCat,
  checkCategoryMins,
  isCamiseta,
  isLongSleeve,
  parseJerseyItem,
  calcJerseyUnitPrice,
} from "./store";

type CheckoutItem = { nombre: string; qty: number; unitPrice: number; productId?: string | undefined };

type ShippingInput = {
  nombre: string;
  dni: string;
  telefono: string;
  email: string;
  provincia: string;
  ciudad: string;
  codigo_postal: string;
  transporte: string;
  sucursal_correo: string;
};

async function revalidateOrderItems(
  supabaseAdmin: any,
  rawItems: CheckoutItem[],
): Promise<{
  validatedItems: CheckoutItem[];
  total: number;
  error?: string;
}> {
  try {
    const [{ data: dbProducts }, { data: dbConfigRows }] = await Promise.all([
      supabaseAdmin.from("products").select("id,nombre,categoria,precio,precio_usd,precio_base,moneda_base,precio_oferta,precio_oferta_usd,precio_oferta_base,moneda_oferta_base,oferta,stock,descuento"),
      supabaseAdmin.from("site_config").select("clave,valor"),
    ]);

    if (!dbProducts || dbProducts.length === 0) {
      return { validatedItems: [], total: 0, error: "No se pudieron obtener los productos de la base de datos." };
    }

    const configObj: Record<string, string> = {};
    if (Array.isArray(dbConfigRows)) {
      for (const row of dbConfigRows) {
        if (row.clave && row.valor !== undefined) configObj[row.clave] = String(row.valor);
      }
    }

    const catRules = parseCategoryRules(configObj);

    const catTotals: Record<string, number> = {};
    const itemsWithCat: { categoria?: string; qty: number; unitPrice: number }[] = [];

    for (const item of rawItems) {
      const prod = findProduct(dbProducts, item.nombre);
      const cat = prod?.categoria ?? "";
      const catNorm = normCat(cat);
      if (catNorm) {
        const match = findRuleForCat(catNorm, catRules);
        const key = match?.key ?? catNorm;
        catTotals[key] = (catTotals[key] ?? 0) + item.qty;
      }
      const baseP = prod ? priceOf(prod) : item.unitPrice;
      itemsWithCat.push({ categoria: cat, qty: item.qty, unitPrice: baseP });
    }

    const violations = checkCategoryMins(itemsWithCat, catRules);
    if (violations.length > 0) {
      const v = violations[0]!;
      const msg =
        v.type === "amount"
          ? `No se cumple el mínimo de compra para ${v.category} ($${v.min.toLocaleString("es-AR")}).`
          : `No se cumple el mínimo de compra para ${v.category} (${v.min} unidades).`;
      return { validatedItems: [], total: 0, error: msg };
    }

    const { isSuplemento, SUPLEMENTOS_MIN } = await import("./store");
    const minSuplementos = catRules[normCat("Suplementos")]?.minAmount || SUPLEMENTOS_MIN;
    const supTotal = rawItems
      .filter((i) => {
        const prod = findProduct(dbProducts, i.nombre);
        return isSuplemento(prod?.categoria, i.nombre);
      })
      .reduce((a, i) => a + i.qty * i.unitPrice, 0);

    if (supTotal > 0 && supTotal < minSuplementos) {
      return {
        validatedItems: [],
        total: 0,
        error: `No se cumple el mínimo de compra para Suplementos ($${minSuplementos.toLocaleString("es-AR")}).`,
      };
    }

    const totalJerseyUnits = rawItems
      .filter((i) => {
        const prod = findProduct(dbProducts, i.nombre);
        return isCamiseta(prod?.categoria, prod?.nombre) || isCamiseta(undefined, i.nombre);
      })
      .reduce((sum, i) => sum + i.qty, 0);
    const usdRate = Number(configObj["dolar_cotizacion"] ?? 0);

    const validatedItems: CheckoutItem[] = rawItems.map((item) => {
      const prod = findProduct(dbProducts, item.nombre);

      if ((prod && isCamiseta(prod.categoria, prod.nombre)) || isCamiseta(undefined, item.nombre)) {
        const { version, isExtraSize, badge } = parseJerseyItem(item);
        const effectiveQty = Math.max(item.qty, totalJerseyUnits);
        const { unitArs } = calcJerseyUnitPrice({
          qty: effectiveQty,
          version,
          isExtraSize,
          badge,
          usdRate,
          isLongSleeve: isLongSleeve(item.nombre) || (prod ? isLongSleeve(prod.nombre) : false),
        });
        return {
          nombre: item.nombre,
          qty: item.qty,
          unitPrice: unitArs > 0 ? unitArs : item.unitPrice,
          ...(item.productId ? { productId: item.productId } : {}),
        };
      }

      if (!prod) return item;

      const catNorm = normCat(prod.categoria ?? "");
      const match = catNorm ? findRuleForCat(catNorm, catRules) : undefined;
      const catRule = match?.rule;
      const ruleKey = match?.key;

      let unitPrice: number;
      if (catRule?.discountTiers?.length && ruleKey) {
        const totalCatUnits = catTotals[ruleKey] ?? 0;
        const percent = categoryDiscountForUnits(catRule.discountTiers, totalCatUnits);
        const base = priceOf(prod);
        unitPrice = Math.round(base * (1 - percent / 100));
      } else {
        unitPrice = Math.round(unitPriceFor(prod, item.qty));
      }

      return {
        nombre: item.nombre,
        qty: item.qty,
        unitPrice: unitPrice > 0 ? unitPrice : item.unitPrice,
        ...(item.productId ? { productId: item.productId } : {}),
      };
    });

    const total = validatedItems.reduce((a, i) => a + i.qty * i.unitPrice, 0);
    return { validatedItems, total };
  } catch (err) {
    console.error("Error al revalidar items en el servidor:", err);
    const total = rawItems.reduce((a, i) => a + i.qty * i.unitPrice, 0);
    return { validatedItems: rawItems, total };
  }
}

/**
 * Crea la preferencia de pago en Mercado Pago Y guarda la orden en Supabase
 * con estado "pendiente". Cuando MP confirma el pago,
 * verifyOrderPayment la actualiza a "pagado".
 */
export const createCheckout = createServerFn({ method: "POST" })
  .validator(
    (data: {
      items: CheckoutItem[];
      origin: string;
      shipping: ShippingInput;
      userId?: string | undefined;
      couponCode?: string | undefined;
    }) => {
      if (!data || !Array.isArray(data.items) || data.items.length === 0) {
        throw new Error("Carrito vacío");
      }
      const s = data.shipping ?? ({} as ShippingInput);
      return {
        origin: String(data.origin ?? "").slice(0, 200),
        userId: data.userId ? String(data.userId).slice(0, 60) : undefined,
        couponCode: data.couponCode ? String(data.couponCode).slice(0, 40).toUpperCase().trim() : undefined,
        shipping: {
          nombre: String(s.nombre ?? "").slice(0, 120),
          dni: String(s.dni ?? "").slice(0, 20),
          telefono: String(s.telefono ?? "").slice(0, 30),
          email: String(s.email ?? "").slice(0, 160),
          provincia: String(s.provincia ?? "").slice(0, 60),
          ciudad: String(s.ciudad ?? "").slice(0, 80),
          codigo_postal: String(s.codigo_postal ?? "").slice(0, 12),
          transporte: String(s.transporte ?? "Correo Argentino").slice(0, 40),
          sucursal_correo: String(s.sucursal_correo ?? "").slice(0, 160),
        },
        items: data.items.slice(0, 50).map((i) => ({
          nombre: String(i.nombre ?? "Producto").slice(0, 120),
          qty: Math.max(1, Math.min(9999, Math.round(Number(i.qty) || 1))),
          unitPrice: Math.max(1, Math.round(Number(i.unitPrice) || 0)),
        })),
      };
    },
  )
  .handler(async ({ data }): Promise<{ url?: string; error?: string }> => {
    const mpToken = process.env["MERCADOPAGO_ACCESS_TOKEN"];
    if (!mpToken) {
      return {
        error: "Falta configurar MercadoPago. Escribinos por WhatsApp para completar tu compra.",
      };
    }

    if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_SERVICE_ROLE_KEY"]) {
      console.error("Supabase no está configurado para crear la orden pendiente.");
      return { error: "No pudimos registrar tu pedido. Probá de nuevo en unos minutos." };
    }

    let items: CheckoutItem[] = [];
    let total = 0;
    let couponDiscountAmount = 0;
    let validCouponApplied: string | null = null;

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      // Garantizar que data.shipping tenga el email de la cuenta si el usuario está logueado
      if (data.userId && (!data.shipping.email || !data.shipping.email.includes("@"))) {
        try {
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(data.userId);
          if (userData?.user?.email) {
            data.shipping.email = userData.user.email.trim();
          }
        } catch (err) {
          console.error("Error al obtener email del usuario en checkout:", err);
        }
      }

      const validation = await revalidateOrderItems(supabaseAdmin, data.items);
      if (validation.error) {
        return { error: validation.error };
      }
      items = validation.validatedItems;
      total = validation.total;

      // Revalidación segura del cupón en el servidor
      if (data.couponCode && data.userId) {
        const { data: dbConfigRows } = await (supabaseAdmin as any).from("site_config").select("clave,valor");
        const configObj: Record<string, string> = {};
        for (const row of dbConfigRows ?? []) {
          if (row.clave && row.valor !== undefined) configObj[row.clave] = String(row.valor);
        }

        const isCouponActive = (configObj["promo_cupon_activo"] ?? "SI").toUpperCase() === "SI";
        const promoCode = (configObj["promo_cupon_codigo"] ?? "TEIMPORTAMOS").toUpperCase().trim();

        if (isCouponActive && data.couponCode === promoCode) {
          const usedKeyUser = `coupon_usage_${promoCode}_${data.userId}`;
          const usedKeyEmail = data.shipping.email ? `coupon_usage_${promoCode}_${data.shipping.email.trim().toLowerCase()}` : "";
          const alreadyUsedInConfig = Boolean(configObj[usedKeyUser] || (usedKeyEmail && configObj[usedKeyEmail]));

          if (!alreadyUsedInConfig) {
            const filterParts: string[] = [`user_id.eq.${data.userId}`];
            if (data.shipping.email) {
              filterParts.push(`user_email.ilike.${data.shipping.email.trim().toLowerCase()}`);
            }
            try {
              const { data: usages } = await (supabaseAdmin as any)
                .from("coupon_usages")
                .select("id")
                .eq("coupon_code", promoCode)
                .or(filterParts.join(","))
                .limit(1);

              if (!usages || usages.length === 0) {
                const couponPct = Number(configObj["promo_cupon_descuento_pct"]) || 5;
                validCouponApplied = promoCode;
                // Aplicar descuento a cada ítem para reflejar el monto en la preferencia de Mercado Pago
                items = items.map((i) => ({
                  ...i,
                  unitPrice: Math.max(1, Math.round(i.unitPrice * (1 - couponPct / 100))),
                }));
                const discountedTotal = items.reduce((a, i) => a + i.qty * i.unitPrice, 0);
                couponDiscountAmount = Math.max(0, total - discountedTotal);
                total = discountedTotal;
              }
            } catch {
              const couponPct = Number(configObj["promo_cupon_descuento_pct"]) || 5;
              validCouponApplied = promoCode;
              items = items.map((i) => ({
                ...i,
                unitPrice: Math.max(1, Math.round(i.unitPrice * (1 - couponPct / 100))),
              }));
              const discountedTotal = items.reduce((a, i) => a + i.qty * i.unitPrice, 0);
              couponDiscountAmount = Math.max(0, total - discountedTotal);
              total = discountedTotal;
            }
          }
        }
      }
    } catch (err) {
      console.error("Error al revalidar la orden:", err);
      return {
        error: "No pudimos validar los precios de tu carrito. Por favor recargá la página e intentalo nuevamente.",
      };
    }

    if (items.length === 0 || total <= 0) {
      return { error: "No se pudieron calcular los totales de tu orden. Por favor recargá la página." };
    }

    // Generamos el código de orden
    const d = new Date();
    const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const orderCode = `TI-${stamp}-${rand}`;

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.from("orders").insert({
        order_code: orderCode,
        user_id: data.userId ?? null,
        ...data.shipping,
        items,
        total,
        estado: "pendiente",
        metodo_pago: "mercadopago",
      });

      if (error) {
        console.error("Error al guardar orden pendiente:", error);
        return { error: "No pudimos registrar tu pedido. Probá de nuevo en unos minutos." };
      }

      // Registrar uso del cupón si fue aplicado
      if (validCouponApplied) {
        try {
          await (supabaseAdmin as any).from("coupon_usages").insert({
            user_id: data.userId ?? null,
            user_email: (data.shipping.email ?? "").trim().toLowerCase(),
            coupon_code: validCouponApplied,
            order_code: orderCode,
            discount_amount: couponDiscountAmount,
          });
        } catch (couponErr) {
          console.error("Error registrando uso de cupón en MP:", couponErr);
        }

        // Registrar SIEMPRE en site_config para garantizar persistencia y bloqueo inmediato
        try {
          const payload = JSON.stringify({
            orderCode,
            email: (data.shipping.email ?? "").trim().toLowerCase(),
            discount: couponDiscountAmount,
            at: new Date().toISOString(),
          });
          if (data.userId) {
            await (supabaseAdmin as any).from("site_config").upsert({
              clave: `coupon_usage_${validCouponApplied}_${data.userId}`,
              valor: payload,
            }, { onConflict: "clave" });
          }
          if (data.shipping.email) {
            await (supabaseAdmin as any).from("site_config").upsert({
              clave: `coupon_usage_${validCouponApplied}_${data.shipping.email.trim().toLowerCase()}`,
              valor: payload,
            }, { onConflict: "clave" });
          }
        } catch (scErr) {
          console.error("Error registrando uso de cupón en site_config (MP):", scErr);
        }
      }
    } catch (err) {
      console.error("Error al guardar orden pendiente:", err);
      return { error: "No pudimos registrar tu pedido. Probá de nuevo en unos minutos." };
    }

    // safeOrigin() valida data.origin contra el allowlist — previene Open Redirect (CWE-601)
    const origin = safeOrigin(data.origin);
    const successUrl = `${origin}/gracias?code=${encodeURIComponent(orderCode)}`;

    const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mpToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        items: items.map((i) => ({
          title: i.nombre,
          quantity: i.qty,
          unit_price: i.unitPrice,
          currency_id: "ARS",
        })),
        external_reference: orderCode,
        back_urls: {
          success: successUrl,
          pending: successUrl,
          failure: `${origin}/carrito`,
        },
        auto_return: "approved",
        payer: {
          name: data.shipping.nombre,
          email: data.shipping.email,
        },
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      console.error(`MercadoPago error [${res.status}]: ${body}`);
      return { error: "No pudimos iniciar el pago. Probá de nuevo o escribinos por WhatsApp." };
    }

    const json = JSON.parse(body) as { init_point?: string; sandbox_init_point?: string };
    const url = json.init_point ?? json.sandbox_init_point;
    return url ? { url } : { error: "No pudimos obtener el enlace de pago. Probá de nuevo." };
  });
