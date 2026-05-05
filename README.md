## 🔬 MoreSim: Systemic Alignment Sandbox
MoreSim es un entorno de simulación standalone diseñado para estresar y validar algoritmos de asignación en redes complejas. Este simulador sirvió como el laboratorio experimental primario para el desarrollo de mi Framework de Optimización Multinivel.
## 🎯 Propósito Filosófico y Técnico
A diferencia de los simuladores comerciales enfocados estrictamente en la eficiencia, MoreSim fue creado para observar la alineación sistémica. Su objetivo es identificar el punto de quiebre donde la optimización de un nodo individual (ej. un repartidor o un pedido) comienza a generar externalidades negativas que degradan la estabilidad de la red global.
## 🧪 Características de Investigación

* Interpretabilidad en Tiempo Real: Incluye un EntityInspector y un LogPanel diseñados para auditar el proceso de toma de decisiones del algoritmo, permitiendo observar la traza del razonamiento sistémico en cada asignación.
* Ajuste Dinámico de Pesos (Scoring): El motor permite modificar en tiempo real las variables de decisión (distancia, tiempos de espera, estados de carga) para analizar cómo cambia el equilibrio del sistema ante diferentes políticas de alineación.
* Arquitectura de Grafos Reales: Utiliza datos de Overpass API y algoritmos de búsqueda de caminos A* para asegurar que las pruebas de estrés ocurran sobre topologías geográficas reales y no sobre espacios abstractos simplificados.

## 🔗 Conexión con el Framework
Este simulador es la evidencia práctica de que la estabilidad de un sistema no es la simple suma de eficiencias locales, sino el resultado de gestionar correctamente las restricciones de acoplamiento. MoreSim permite visualizar la brecha entre la optimización lineal y la estabilidad sistémica, validando las bases experimentales de mi propuesta de seguridad y alineación en IA.
