import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './print.css'
// Вид формы — тот же файл, что у публичной страницы и у кабинета.
import '@fields/fields.css'

import { setMediaBase } from '@fields/media'

import { readPrintData } from './data'
import { PrintView } from './PrintView'

const data = readPrintData()

// Откуда странице брать картинки, решает сервер (mediaBase в данных): у браузера
// принтера нет доступа к раздаче Caddy, и адреса обложки, логотипа и картинок блоков
// ведут на api. Выставляется ДО первой отрисовки — иначе первая же картинка уедет по
// прежнему адресу и не найдётся.
if (data) setMediaBase(data.mediaBase)

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
