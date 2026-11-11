// The package's own types are at 'sweetalert2'. The file imported here is the build without the
// stylesheet injected into the page, so the app can load and theme the stylesheet itself.
declare module 'sweetalert2/dist/sweetalert2.esm.js' {
  import Swal from 'sweetalert2';
  export default Swal;
}
