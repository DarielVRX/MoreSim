## 🔬 MoreSim: Un entorno de experimentación sistémica
MoreSim es un simulador nacido de la curiosidad y la necesidad de entender cómo interactúan los elementos de un sistema de entrega en tiempo real. Más que un producto terminado, es un laboratorio de aprendizaje que sirvió para observar las primeras intuiciones que dieron pie a mi actual propuesta de optimización.
## 🎯 Propósito y Contexto
Este proyecto surgió antes de que tuviera las herramientas matemáticas para formalizar mis ideas. Su objetivo era simple pero ambicioso: intentar visualizar por qué, cuando buscamos la máxima eficiencia individual, el sistema global a veces comienza a fallar. Es un intento honesto de pasar de la filosofía a la simulación.
## 🧪 Estado actual y Limitaciones (Work in Progress)
Soy plenamente consciente de que este simulador es una versión en desarrollo:

* Presencia de Bugs: Existen errores confirmados y otros por descubrir. No es un software de producción, sino una herramienta de prototipado personal.
* Desalineación Operativa: Algunas lógicas pueden no reflejar la realidad exacta del campo, ya que es un espacio de prueba para conceptos teóricos.
* Enfoque en el Aprendizaje: Su valor no reside en la perfección del código, sino en la capacidad de observar cómo pequeñas variaciones en las variables de asignación afectan la estabilidad de la red.

## 🔗 Características Experimentales

* Pruebas de Scoring: Permite jugar con los pesos de las variables (distancia, tiempos) para ver, de forma visual, cómo cambia el comportamiento de los "repartidores".
* Uso de Datos Reales: Implementa Overpass API y A* para que las pruebas ocurran sobre mapas reales, aportando una capa de realidad a la experimentación.
* Auditoría Visual: Incluye paneles básicos para intentar entender el "por qué" de cada decisión del algoritmo, un primer paso hacia la búsqueda de interpretabilidad.

Este simulador representa mi proceso de aprendizaje: una búsqueda empírica para construir "pisos firmes" donde antes solo había intuiciones sobre fallos sistémicos.

