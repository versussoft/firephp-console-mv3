<?php
header('Content-Type: application/json');
echo json_encode(['x-firephp-version'=>$_SERVER['HTTP_X_FIREPHP_VERSION']??null,'ua'=>$_SERVER['HTTP_USER_AGENT']??null,'wf-proto'=>$_SERVER['HTTP_X_WF_PROTOCOL_1']??null]);
