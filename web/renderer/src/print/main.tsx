import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './print.css'
// Вид формы — тот же файл, что у публичной страницы и у кабинета.
import '@fields/fields.css'

import { readPrintData } from './data'
import { PrintView } from './PrintView'

const data = readPrintData()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {data ? (
      <PrintView data={data} />
    ) : (
      // Печатать нечего — говорим об этом на листе. Пустая страница выглядела бы как
      // форма без вопросов, и разобраться в этом по PDF было бы нельзя.
      <main className="rf-page">
        <p className="rf-empty">Данные ответа не переданы — печатать нечего.</p>
      </main>
    )}
  </StrictMode>,
)
