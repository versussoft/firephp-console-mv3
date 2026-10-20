<?php
require __DIR__.'/vendor/autoload.php';
ChromePhp::log('hola', ['x'=>1]);
ChromePhp::warn('aviso');
ChromePhp::group(); ChromePhp::info('dentro'); ChromePhp::groupEnd();
ChromePhp::table([['a'=>1,'b'=>2],['a'=>3,'b'=>4]]);
echo "ok";
