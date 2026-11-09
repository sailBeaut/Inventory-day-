import * as esbuild from "esbuild"; import fs from "fs";
const r = await esbuild.build({ entryPoints:["src/app.js"], bundle:true, format:"iife", minify:true, write:false, target:["es2020","safari15"],
  loader:{".wasm":"binary",".gs":"text"}, external:["html2canvas","dompurify","canvg"], define:{"process.env.NODE_ENV":'"production"'}, logLevel:"warning",
  platform:"browser" });
let js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("src/template.html","utf8").replace("/*__APP__*/", () => js);
fs.writeFileSync("dist.html", html); console.log((html.length/1024/1024).toFixed(2)+" MB");
