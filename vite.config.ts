import {defineConfig} from 'vite';
export default defineConfig({server:{port:4330,strictPort:true,proxy:{'/api':'http://127.0.0.1:4321'}},build:{outDir:'dist'}});
