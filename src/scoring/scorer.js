// src/scoring/scorer.js
//
// Aplica las variables definidas en variables.js a un candidato (driver).
// Retorna { score, breakdown, disqualified, reason } por candidato.
// El AssignmentEngine llama esto por cada driver disponible y elige el mayor score.

/**
 * Evalúa una variable individual.
 * Si tiene formula_override, lo ejecuta en un contexto sandboxeado básico.
 * Si no, llama a compute().
 */
function evalVariable(variable, driver, order, restaurant, customer, world) {
  if (variable.formula_override) {
    try {
      // Sandbox mínimo: la fórmula recibe los mismos args que compute()
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        'driver', 'order', 'restaurant', 'customer', 'world',
        `"use strict"; return (${variable.formula_override});`
      );
      return fn(driver, order, restaurant, customer, world);
    } catch (err) {
      console.warn(`[scorer] Error en formula_override de "${variable.id}":`, err.message);
      // Fallback a compute() si la fórmula falla
      return variable.compute(driver, order, restaurant, customer, world);
    }
  }
  return variable.compute(driver, order, restaurant, customer, world);
}

/**
 * Puntúa un driver candidato contra un pedido.
 *
 * @param {object} driver      - entidad driver con _eta_to_restaurant_s ya calculado
 * @param {object} order       - pedido a asignar
 * @param {object} restaurant  - restaurante del pedido
 * @param {object} customer    - cliente del pedido
 * @param {object[]} variables - array de variables activas (de mergeWithSaved)
 * @param {object} world       - { params, drivers, restaurants, customers, orders }
 * @returns {{ score: number, breakdown: object[], disqualified: bool, reason: string|null }}
 */
export function scoreDriver(driver, order, restaurant, customer, variables, world) {
  const breakdown = [];
  let totalWeight  = 0;
  let weightedSum  = 0;

  for (const variable of variables) {
    if (!variable.enabled) continue;

    const raw = evalVariable(variable, driver, order, restaurant, customer, world);

    if (variable.effect === 'gate') {
      if (!raw) {
        return {
          score:         -Infinity,
          breakdown,
          disqualified:  true,
          reason:        `Gate fallido: ${variable.name}`,
        };
      }
      breakdown.push({ id: variable.id, name: variable.name, value: 'PASS', contribution: 0 });
      continue;
    }

    // Normalizar: minimize → invertir el valor
    const normalized = variable.effect === 'minimize'
      ? 1 - Math.max(0, Math.min(1, raw))
      : Math.max(0, Math.min(1, raw));

    const contribution = normalized * variable.weight;
    weightedSum  += contribution;
    totalWeight  += variable.weight;

    breakdown.push({
      id:           variable.id,
      name:         variable.name,
      raw,
      normalized,
      weight:       variable.weight,
      contribution: +contribution.toFixed(3),
    });
  }

  const score = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;

  return {
    score:        +score.toFixed(2),
    breakdown,
    disqualified: false,
    reason:       null,
  };
}

/**
 * Elige el mejor driver para un pedido entre todos los candidatos.
 * Retorna { winner, results } donde results incluye todos los candidatos y sus scores.
 *
 * @param {object[]} drivers    - todos los drivers del mundo
 * @param {object}   order
 * @param {object}   restaurant
 * @param {object}   customer
 * @param {object[]} variables
 * @param {object}   world
 * @returns {{ winner: object|null, results: object[] }}
 */
export function pickBestDriver(drivers, order, restaurant, customer, variables, world) {
  const results = drivers.map(driver => ({
    driver,
    ...scoreDriver(driver, order, restaurant, customer, variables, world),
  }));

  const qualified = results.filter(r => !r.disqualified);

  if (qualified.length === 0) {
    return { winner: null, results };
  }

  qualified.sort((a, b) => b.score - a.score);
  return { winner: qualified[0].driver, results };
}
