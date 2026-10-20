<?php
require __DIR__.'/vendor/autoload.php';
ob_start();
$f = FirePHP::getInstance(true);
$f->info('Página principal cargada');
$f->log(['usuario'=>'demo','roles'=>['admin','dev']], 'Sesión');
?><html><body><h1>Demo</h1><script>fetch('/core.php').then(r=>r.text()).then(()=>fetch('/chromephp.php'));</script></body></html>
